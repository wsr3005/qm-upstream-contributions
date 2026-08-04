import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CliError } from "./log.ts";
import type { ResolvedPlugin } from "./plugins.ts";
import { registerProcessCleanup } from "./process-cleanup.ts";

export interface SourcePluginBuildContext {
  directory: string;
  dockerfile: string;
  ignorefile: string;
}

interface DockerIgnoreMatcher {
  add(pattern: string): DockerIgnoreMatcher;
  ignores(path: string): boolean;
}

type DockerIgnoreFactory = (options: { ignorecase: boolean }) => DockerIgnoreMatcher;

const dockerIgnore = createRequire(import.meta.url)("@balena/dockerignore") as DockerIgnoreFactory;

function removeContext(directory: string): void {
  if (!existsSync(directory)) return;
  const makeRemovable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, stat.mode | 0o700);
    for (const entry of readdirSync(path)) makeRemovable(join(path, entry));
  };
  makeRemovable(directory);
  rmSync(directory, { recursive: true, force: true });
}

function trackContext(directory: string): () => void {
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    removeContext(directory);
  };
  const unregister = registerProcessCleanup(remove);
  return () => {
    unregister();
    remove();
  };
}

function chassisDirectory(): string {
  const candidates = [
    fileURLToPath(new URL("../plugin-chassis", import.meta.url)),
    fileURLToPath(new URL("../../plugins/chassis", import.meta.url)),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  if (!found) throw new CliError("the packaged source plugin chassis is missing");
  return found;
}

function contextPath(root: string, path: string, pluginName: string, label: string): string {
  const resolved = relative(root, path);
  if (!resolved || isAbsolute(resolved) || resolved === ".." || resolved.startsWith(`..${sep}`)) {
    throw new CliError(`plugin ${pluginName} ${label} must be inside its source directory`);
  }
  return resolved;
}

function exclusionPatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.startsWith("!")) return [line];
      if (line.startsWith("/!")) return [line.slice(1)];
      return [];
    });
}

function exclusionCouldMatchWithin(directory: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pattern = raw.slice(1).replace(/^\/+/, "").replace(/\/+$/, "");
    if (!pattern || pattern.includes("\\")) return true;
    const wildcard = pattern.search(/[?*[]/);
    const prefix = (wildcard === -1 ? pattern : pattern.slice(0, wildcard)).replace(/\/+$/, "");
    if (!prefix) return true;
    return prefix === directory || prefix.startsWith(`${directory}/`) || directory.startsWith(prefix);
  });
}

function portablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function copyFilteredContext(
  sourceRoot: string,
  destinationRoot: string,
  ignoreContent: string,
  mandatoryPaths: Set<string>,
): void {
  const matcher = dockerIgnore({ ignorecase: false }).add(ignoreContent);
  const exclusions = exclusionPatterns(ignoreContent);
  const copyDirectory = (source: string, destination: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const relativePath = portablePath(relative(sourceRoot, sourcePath));
      if (relativePath === "plugins/chassis" || relativePath.startsWith("plugins/chassis/")) continue;
      const mandatory = mandatoryPaths.has(relativePath);
      const ignored = !mandatory && matcher.ignores(relativePath);
      if (entry.isSymbolicLink()) {
        if (!ignored) symlinkSync(readlinkSync(sourcePath), destinationPath);
        continue;
      }
      if (entry.isDirectory()) {
        const mandatoryDescendant = [...mandatoryPaths].some((path) => path.startsWith(`${relativePath}/`));
        if (ignored && !mandatoryDescendant && !exclusionCouldMatchWithin(relativePath, exclusions)) continue;
        mkdirSync(destinationPath);
        copyDirectory(sourcePath, destinationPath);
        chmodSync(destinationPath, lstatSync(sourcePath).mode);
        continue;
      }
      if (ignored) continue;
      cpSync(sourcePath, destinationPath, { preserveTimestamps: true, verbatimSymlinks: true });
    }
  };
  copyDirectory(sourceRoot, destinationRoot);
}

function injectChassis(directory: string, pluginName: string): void {
  const plugins = join(directory, "plugins");
  let pluginsMode: number | undefined;
  if (existsSync(plugins)) {
    const stat = lstatSync(plugins);
    if (stat.isSymbolicLink()) throw new CliError(`plugin ${pluginName} plugins path cannot be a symbolic link`);
    if (!stat.isDirectory()) throw new CliError(`plugin ${pluginName} plugins path must be a directory`);
    pluginsMode = stat.mode;
    chmodSync(plugins, stat.mode | 0o700);
  } else {
    mkdirSync(plugins);
  }
  const chassis = join(plugins, "chassis");
  if (existsSync(chassis)) throw new CliError(`plugin ${pluginName} plugins/chassis path is reserved`);
  try {
    cpSync(chassisDirectory(), chassis, { recursive: true, verbatimSymlinks: true });
  } finally {
    if (pluginsMode !== undefined) chmodSync(plugins, pluginsMode);
  }
}

function prepareSourcePluginBuildContext(plugin: ResolvedPlugin): SourcePluginBuildContext & { cleanup: () => void } {
  if (plugin.kind !== "source" || !plugin.sourceDir || !plugin.dockerfile) {
    throw new CliError(`plugin ${plugin.name} is not a source plugin`);
  }
  const dockerfile = contextPath(plugin.sourceDir, plugin.dockerfile, plugin.name, "Dockerfile");
  const dockerfileIgnore = `${plugin.dockerfile}.dockerignore`;
  const rootIgnore = join(plugin.sourceDir, ".dockerignore");
  const ignoreFile = existsSync(dockerfileIgnore) ? dockerfileIgnore : existsSync(rootIgnore) ? rootIgnore : undefined;
  const ignoreContent = ignoreFile ? readFileSync(ignoreFile, "utf8") : "";
  const ignorePath = ignoreFile ? contextPath(plugin.sourceDir, ignoreFile, plugin.name, "ignore file") : undefined;
  const mandatoryPaths = new Set([portablePath(dockerfile), ...(ignorePath ? [portablePath(ignorePath)] : [])]);
  const directory = mkdtempSync(join(tmpdir(), "qm-plugin-build-"));
  const cleanup = trackContext(directory);
  try {
    copyFilteredContext(plugin.sourceDir, directory, ignoreContent, mandatoryPaths);
    injectChassis(directory, plugin.name);
    const buildDockerfile = `.qm-plugin-${randomUUID()}.Dockerfile`;
    const buildIgnore = `${buildDockerfile}.dockerignore`;
    cpSync(plugin.dockerfile, join(directory, buildDockerfile), { dereference: true, preserveTimestamps: true });
    const separator = ignoreContent.endsWith("\n") || ignoreContent.length === 0 ? "" : "\n";
    writeFileSync(
      join(directory, buildIgnore),
      `${ignoreContent}${separator}${buildDockerfile}\n${buildIgnore}\n!plugins\n!plugins/chassis\n!plugins/chassis/**\n`,
    );
    return {
      directory,
      dockerfile: join(directory, buildDockerfile),
      ignorefile: join(directory, buildIgnore),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function withSourcePluginBuildContext<T>(
  plugin: ResolvedPlugin,
  build: (context: SourcePluginBuildContext) => T,
): T {
  const { cleanup, ...context } = prepareSourcePluginBuildContext(plugin);
  try {
    return build(context);
  } finally {
    cleanup();
  }
}

export async function withSourcePluginBuildContextAsync<T>(
  plugin: ResolvedPlugin,
  build: (context: SourcePluginBuildContext) => Promise<T>,
): Promise<T> {
  const { cleanup, ...context } = prepareSourcePluginBuildContext(plugin);
  try {
    return await build(context);
  } finally {
    cleanup();
  }
}
