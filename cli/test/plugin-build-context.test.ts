import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { withSourcePluginBuildContext, withSourcePluginBuildContextAsync } from "../src/plugin-build-context.ts";
import type { ResolvedPlugin } from "../src/plugins.ts";
import { runInheritAsync } from "../src/util.ts";

function sourcePlugin(root: string): ResolvedPlugin {
  const sourceDir = join(root, "plugins", "example");
  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(join(sourceDir, "Dockerfile"), "FROM scratch\nCOPY package.json /app/package.json\n");
  writeFileSync(join(sourceDir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(sourceDir, "src", "index.mjs"), 'export const value = "plugin";\n');
  writeFileSync(join(sourceDir, ".dockerignore"), "node_modules\n");
  return {
    name: "example",
    kind: "source",
    sourceDir,
    dockerfile: join(sourceDir, "Dockerfile"),
    env: {},
  };
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["version", "-f", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("source plugin build contexts preserve the plugin root and add the packaged chassis", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-test-"));
  try {
    const plugin = sourcePlugin(root);
    let preparedDir = "";
    const result = withSourcePluginBuildContext(plugin, (prepared) => {
      preparedDir = prepared.directory;
      assert.notEqual(prepared.directory, plugin.sourceDir);
      assert.equal(dirname(prepared.dockerfile), prepared.directory);
      assert.match(basename(prepared.dockerfile), /^\.qm-plugin-.+\.Dockerfile$/);
      assert.equal(readFileSync(join(prepared.directory, "package.json"), "utf8"), '{"type":"module"}\n');
      assert.equal(
        readFileSync(join(prepared.directory, "src", "index.mjs"), "utf8"),
        'export const value = "plugin";\n',
      );
      assert.equal(readFileSync(join(prepared.directory, ".dockerignore"), "utf8"), "node_modules\n");
      assert.match(
        readFileSync(join(prepared.directory, "plugins", "chassis", "src", "errors.ts"), "utf8"),
        /export function errMessage/,
      );
      return "built";
    });
    assert.equal(result, "built");
    assert.equal(existsSync(preparedDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source plugin build contexts are removed after synchronous build failures", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-test-"));
  try {
    const plugin = sourcePlugin(root);
    let preparedDir = "";
    assert.throws(
      () =>
        withSourcePluginBuildContext(plugin, (prepared) => {
          preparedDir = prepared.directory;
          throw new Error("build failed");
        }),
      /build failed/,
    );
    assert.equal(existsSync(preparedDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source plugin build contexts are removed after asynchronous builds settle", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-test-"));
  try {
    const plugin = sourcePlugin(root);
    let successDir = "";
    const result = await withSourcePluginBuildContextAsync(plugin, async (prepared) => {
      successDir = prepared.directory;
      await Promise.resolve();
      return "deployed";
    });
    assert.equal(result, "deployed");
    assert.equal(existsSync(successDir), false);

    let failureDir = "";
    await assert.rejects(
      withSourcePluginBuildContextAsync(plugin, async (prepared) => {
        failureDir = prepared.directory;
        await Promise.resolve();
        throw new Error("deploy failed");
      }),
      /deploy failed/,
    );
    assert.equal(existsSync(failureDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a generic source plugin image can import the chassis copied from its prepared context",
  { skip: !dockerAvailable() },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-smoke-"));
    const image = `qm-plugin-context-smoke:${randomUUID()}`;
    try {
      const plugin = sourcePlugin(root);
      writeFileSync(join(plugin.sourceDir!, ".dockerignore"), "node_modules\nplugins\n");
      writeFileSync(
        plugin.dockerfile!,
        'FROM node:24-alpine\nWORKDIR /app\nCOPY package.json .\nCOPY src ./src\nCOPY plugins/chassis /plugins/chassis\nCMD ["node", "src/index.ts"]\n',
      );
      writeFileSync(
        join(plugin.sourceDir!, "src", "index.ts"),
        'import { errMessage } from "../../plugins/chassis/src/errors.ts";\nprocess.stdout.write(errMessage(new Error("chassis-loaded")));\n',
      );
      await withSourcePluginBuildContextAsync(plugin, async (prepared) => {
        await runInheritAsync("docker", ["build", "-f", prepared.dockerfile, "-t", image, prepared.directory]);
      });
      assert.equal(execFileSync("docker", ["run", "--rm", image], { encoding: "utf8" }), "chassis-loaded");
    } finally {
      spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "prepared contexts preserve relative symlinks and build the same runnable image",
  { skip: !dockerAvailable() },
  () => {
    const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-symlink-"));
    const image = `qm-plugin-context-symlink:${randomUUID()}`;
    try {
      const plugin = sourcePlugin(root);
      mkdirSync(join(plugin.sourceDir!, "shared"));
      writeFileSync(join(plugin.sourceDir!, "shared", "value.txt"), "relative-link-works\n");
      symlinkSync("../shared", join(plugin.sourceDir!, "src", "shared"));
      writeFileSync(plugin.dockerfile!, 'FROM alpine:3.22\nCOPY . /app\nCMD ["cat", "/app/src/shared/value.txt"]\n');
      withSourcePluginBuildContext(plugin, (prepared) => {
        assert.equal(readlinkSync(join(prepared.directory, "src", "shared")), "../shared");
        execFileSync("docker", ["build", "-f", prepared.dockerfile, "-t", image, prepared.directory], {
          stdio: "pipe",
        });
      });
      assert.equal(execFileSync("docker", ["run", "--rm", image], { encoding: "utf8" }), "relative-link-works\n");
    } finally {
      spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("plugin-controlled symlink ancestors cannot redirect chassis injection", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-escape-"));
  const outside = mkdtempSync(join(tmpdir(), "qm-plugin-context-outside-"));
  try {
    const plugin = sourcePlugin(root);
    const pluginPlugins = join(plugin.sourceDir!, "plugins");
    mkdirSync(join(outside, "chassis"));
    writeFileSync(join(outside, "chassis", "marker"), "untouched\n");
    symlinkSync(outside, pluginPlugins);
    assert.throws(() => withSourcePluginBuildContext(plugin, () => undefined), /plugins.*symbolic link/);
    assert.equal(readFileSync(join(outside, "chassis", "marker"), "utf8"), "untouched\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("prepared contexts never materialize files excluded by the effective Docker ignore rules", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-ignore-"));
  try {
    const plugin = sourcePlugin(root);
    writeFileSync(join(plugin.sourceDir!, ".dockerignore"), ".env\nnode_modules\nignored-cache\n");
    writeFileSync(join(plugin.sourceDir!, ".env"), "PRIVATE_TOKEN=secret\n");
    mkdirSync(join(plugin.sourceDir!, "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(plugin.sourceDir!, "node_modules", "dependency", "index.js"), "secret cache\n");
    mkdirSync(join(plugin.sourceDir!, "ignored-cache"));
    writeFileSync(join(plugin.sourceDir!, "ignored-cache", "token"), "secret cache\n");
    chmodSync(join(plugin.sourceDir!, ".env"), 0o000);
    chmodSync(join(plugin.sourceDir!, "node_modules"), 0o000);
    try {
      withSourcePluginBuildContext(plugin, (prepared) => {
        assert.equal(existsSync(join(prepared.directory, ".env")), false);
        assert.equal(existsSync(join(prepared.directory, "node_modules")), false);
        assert.equal(existsSync(join(prepared.directory, "ignored-cache")), false);
        assert.equal(existsSync(join(prepared.directory, "package.json")), true);
        assert.equal(existsSync(join(prepared.directory, "plugins", "chassis", "src", "errors.ts")), true);
      });
    } finally {
      chmodSync(join(plugin.sourceDir!, ".env"), 0o600);
      chmodSync(join(plugin.sourceDir!, "node_modules"), 0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Dockerfile-specific ignore rules take precedence without changing either source ignore file", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-specific-ignore-"));
  try {
    const plugin = sourcePlugin(root);
    const rootIgnore = "root-secret\n";
    const dockerfileIgnore = "specific-secret\nplugins\n";
    writeFileSync(join(plugin.sourceDir!, ".dockerignore"), rootIgnore);
    writeFileSync(`${plugin.dockerfile!}.dockerignore`, dockerfileIgnore);
    writeFileSync(join(plugin.sourceDir!, "root-secret"), "included by the effective rules\n");
    writeFileSync(join(plugin.sourceDir!, "specific-secret"), "excluded by the effective rules\n");
    withSourcePluginBuildContext(plugin, (prepared) => {
      assert.equal(existsSync(join(prepared.directory, "root-secret")), true);
      assert.equal(existsSync(join(prepared.directory, "specific-secret")), false);
      assert.equal(readFileSync(join(prepared.directory, ".dockerignore"), "utf8"), rootIgnore);
      assert.equal(readFileSync(join(prepared.directory, "Dockerfile.dockerignore"), "utf8"), dockerfileIgnore);
      assert.match(readFileSync(`${prepared.dockerfile}.dockerignore`, "utf8"), /!plugins\/chassis\/\*\*/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("negated Docker ignore rules can restore descendants without restoring unrelated trees", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-negated-ignore-"));
  try {
    const plugin = sourcePlugin(root);
    writeFileSync(join(plugin.sourceDir!, ".dockerignore"), "*\n!package.json\n!src/**\n");
    writeFileSync(join(plugin.sourceDir!, "secret"), "excluded\n");
    mkdirSync(join(plugin.sourceDir!, "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(plugin.sourceDir!, "node_modules", "dependency", "index.js"), "excluded\n");
    withSourcePluginBuildContext(plugin, (prepared) => {
      assert.equal(existsSync(join(prepared.directory, "secret")), false);
      assert.equal(existsSync(join(prepared.directory, "node_modules")), false);
      assert.equal(existsSync(join(prepared.directory, "package.json")), true);
      assert.equal(existsSync(join(prepared.directory, "src", "index.mjs")), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM removes a prepared context before the process exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-plugin-context-signal-"));
  const marker = join(root, "prepared-path");
  const plugin = sourcePlugin(root);
  const script = `
import { writeFileSync } from "node:fs";
import { withSourcePluginBuildContextAsync } from ${JSON.stringify(new URL("../src/plugin-build-context.ts", import.meta.url).href)};
import { runInheritAsync } from ${JSON.stringify(new URL("../src/util.ts", import.meta.url).href)};
const plugin = JSON.parse(process.env.QM_TEST_PLUGIN);
await withSourcePluginBuildContextAsync(plugin, async (prepared) => {
  writeFileSync(process.env.QM_TEST_MARKER, prepared.directory);
  await runInheritAsync(process.execPath, ["--eval", "const parent = process.ppid; setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 25)"]);
});
`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      QM_TEST_MARKER: marker,
      QM_TEST_PLUGIN: JSON.stringify(plugin),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForFile(marker);
    const prepared = readFileSync(marker, "utf8");
    assert.equal(existsSync(prepared), true);
    child.kill("SIGTERM");
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    assert.equal(existsSync(prepared), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
