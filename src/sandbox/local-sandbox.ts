import { createHash, randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const AGENT_PORT = 8080;
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const LOCAL_SANDBOX_PLATFORM = "linux/amd64";
const BUILD_HINT = "run `npm run sandbox:local:build`";
const DOCKER_DAEMON_HINT = "SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)";

export type { DockerExec };

export interface LocalSandboxOptions {
  image?: string;
  dockerBin?: string;
  controllerContainer?: string;
  orgId?: string;
  environment?: "dev" | "production";
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const FINGERPRINT_FIXED_SOURCES = ["fly/Dockerfile", "local/Dockerfile", "aws/microvm-agent/agent.mjs"];

export async function computeSandboxImageFingerprint(repoRoot: string): Promise<string | null> {
  try {
    const tools = (await readdir(join(repoRoot, "fly/tools"))).sort().map((f) => `fly/tools/${f}`);
    const paths = [...FINGERPRINT_FIXED_SOURCES, ...tools].sort();
    const fp = createHash("sha256");
    for (const p of paths) {
      fp.update(p);
      fp.update("\0");
      fp.update(
        createHash("sha256")
          .update(await fsReadFile(join(repoRoot, p)))
          .digest(),
      );
      fp.update("\n");
    }
    return fp.digest("hex");
  } catch {
    return null;
  }
}

export const localContainerName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-sbx-${localSlug(`${orgId}:${scopeId}`)}`;
export const localVolumeName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-home-${localSlug(`${orgId}:${scopeId}`)}`;
export const legacyLocalContainerName = (scopeId: string): string => `qm-sbx-${legacyLocalSlug(scopeId)}`;
export const legacyLocalVolumeName = (scopeId: string): string => `qm-home-${legacyLocalSlug(scopeId)}`;
export const localMigrationSentinelName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-migration-${localSlug(`${orgId}:${scopeId}:legacy`)}`;
export const localDestroyMarkerName = (scopeId: string, orgId = configOrgId()): string =>
  `qm-destroy-${localSlug(`${orgId}:${scopeId}:pending`)}`;
export const localNetworkName = (containerName: string): string =>
  `qm-net-${containerName.replace(/^qm-(sbx|scratch)-/, "")}`;
const localScratchName = (key: string, orgId: string): string => `qm-scratch-${localSlug(`${orgId}:${key}`)}`;

function localSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${cleaned.slice(0, 32).replace(/-+$/, "") || "scope"}-${digest}`;
}

function legacyLocalSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

function resourceIsMissing(kind: "container" | "network" | "volume", stderr: string): boolean {
  const value = stderr.trim().toLowerCase();
  if (kind === "container") return value.includes("no such object") || value.includes("no such container");
  if (kind === "network") {
    return value.includes("no such network") || /^error response from daemon: network .+ not found$/u.test(value);
  }
  return value.includes("no such volume") || value.includes("volume not found");
}

function dockerDaemonUnavailable(stderr: string): boolean {
  const value = stderr.trim().toLowerCase();
  return value.includes("cannot connect to the docker daemon") || value.includes("is the docker daemon running");
}

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const orgId = opts.orgId ?? configOrgId();
  const environment = opts.environment ?? "dev";
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const destroyRequested = new Set<string>();
  const releasedHandles = new WeakSet<object>();
  const activeByContainer = new Map<string, number>();
  const controllerNetworks = new Set<string>();

  let preflightDone: Promise<string> | undefined;
  let staleWarned = false;

  async function preflight(): Promise<string> {
    preflightDone ??= (async () => {
      const version = await dexec(["version"], 15_000);
      if (version.code !== 0) {
        preflightDone = undefined;
        throw new Error(DOCKER_DAEMON_HINT);
      }
      const img = await dexec([
        "image",
        "inspect",
        "-f",
        `{{.Id}} {{if .Config.Labels}}{{index .Config.Labels "${FINGERPRINT_LABEL}"}}{{end}}`,
        image,
      ]);
      if (img.code !== 0) {
        preflightDone = undefined;
        throw new Error(`local sandbox image ${image} not found — ${BUILD_HINT}`);
      }
      const [imageId = "", labeled = ""] = img.stdout.trim().split(/\s+/);
      if (!staleWarned) {
        const want = await computeSandboxImageFingerprint(opts.repoRoot ?? process.cwd());
        if (want && labeled && labeled !== want) {
          staleWarned = true;
          console.warn(`[local-sandbox] sandbox image ${image} is stale — ${BUILD_HINT}`);
        }
      }
      return imageId;
    })();
    return preflightDone;
  }

  async function containerState(name: string): Promise<{ running: boolean; imageId: string; platform: string } | null> {
    const r = await dexec([
      "inspect",
      "-f",
      `{{.State.Running}} {{.Image}} {{if .Config.Labels}}{{index .Config.Labels "qm.org"}} {{index .Config.Labels "qm.sandbox-platform"}}{{end}}`,
      name,
    ]);
    if (r.code !== 0) {
      if (resourceIsMissing("container", r.stderr)) return null;
      throw new Error(`docker container inspect ${name} failed: ${r.stderr.trim()}`);
    }
    const [running = "", imageId = "", owner = "", platform = ""] = r.stdout.trim().split(/\s+/);
    if (owner !== orgId) throw new Error(`local sandbox ${name} belongs to ${owner || "an unknown organization"}`);
    return { running: running === "true", imageId, platform };
  }

  async function resolvePort(name: string): Promise<number> {
    const cached = portByName.get(name);
    if (cached) return cached;
    const r = await dexec(["port", name, `${AGENT_PORT}/tcp`]);
    const m = r.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (r.code !== 0 || !m)
      throw new Error(`local sandbox ${name}: cannot resolve agent port: ${r.stderr.trim() || r.stdout.trim()}`);
    const port = Number(m[1]);
    portByName.set(name, port);
    return port;
  }

  async function daemon(
    name: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const port = opts.controllerContainer ? AGENT_PORT : await resolvePort(name);
    const host = opts.controllerContainer ? name : "127.0.0.1";
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`http://${host}:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  }

  async function waitDaemon(name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await daemon(name, "/health", undefined, 3000);
        if (res.status === 200) return;
        lastErr = `http ${res.status}`;
      } catch (e) {
        lastErr = errMessage(e);
      }
      await sleep(300);
    }
    throw new Error(`local sandbox ${name}: exec daemon never became reachable: ${lastErr}`);
  }

  async function startContainer(name: string): Promise<void> {
    portByName.delete(name);
    const r = await dexec(["start", name]);
    if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim()}`);
    await connectController(name);
    await waitDaemon(name);
  }

  async function ensureRunning(name: string): Promise<void> {
    const state = await containerState(name);
    if (!state) throw new Error(`local sandbox container ${name} is gone`);
    if (!state.running) await startContainer(name);
  }

  async function execRaw(name: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult> {
    const res = await daemon(name, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000, signal);
    if (res.status !== 200) throw new Error(`local sandbox exec failed (${res.status}): ${res.text.slice(0, 300)}`);
    const j = JSON.parse(res.text) as { stdout: string; stderr: string; code: number; timedOut: boolean };
    return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const res = await daemon(name, "/write", { path: absPath, b64: Buffer.from(data).toString("base64") }, 120_000);
    if (res.status !== 200)
      throw new Error(`local sandbox write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const res = await daemon(name, "/read", { path: absPath }, 120_000);
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`local sandbox read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function ownedResourceExists(kind: "network" | "volume", name: string): Promise<boolean> {
    const r = await dexec([kind, "inspect", "-f", `{{if .Labels}}{{index .Labels "qm.org"}}{{end}}`, name]);
    if (r.code !== 0) {
      if (resourceIsMissing(kind, r.stderr)) return false;
      if (dockerDaemonUnavailable(r.stderr)) throw new Error(DOCKER_DAEMON_HINT);
      throw new Error(`docker ${kind} inspect ${name} failed: ${r.stderr.trim()}`);
    }
    const owner = r.stdout.trim();
    if (owner !== orgId)
      throw new Error(`local sandbox ${kind} ${name} belongs to ${owner || "an unknown organization"}`);
    return true;
  }

  async function ensureNetwork(name: string): Promise<string> {
    const net = localNetworkName(name);
    if (!(await ownedResourceExists("network", net))) {
      const r = await dexec(["network", "create", "--label", `qm.org=${orgId}`, net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
      if (!(await ownedResourceExists("network", net))) {
        throw new Error(`docker network create ${net} did not create an inspectable owned network`);
      }
    }
    return net;
  }

  async function connectController(name: string): Promise<void> {
    if (!opts.controllerContainer) return;
    const net = localNetworkName(name);
    if (controllerNetworks.has(net)) return;
    const r = await dexec(["network", "connect", net, opts.controllerContainer]);
    if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
      throw new Error(`docker network connect ${net} failed: ${r.stderr.trim()}`);
    }
    controllerNetworks.add(net);
  }

  async function removeContainer(name: string): Promise<void> {
    const r = await dexec(["rm", "-f", name]);
    if (r.code === 0 || resourceIsMissing("container", r.stderr)) return;
    throw new Error(`docker container rm ${name} failed: ${r.stderr.trim()}`);
  }

  async function removeVolume(name: string): Promise<void> {
    const r = await dexec(["volume", "rm", name]);
    if (r.code === 0 || resourceIsMissing("volume", r.stderr)) return;
    throw new Error(`docker volume rm ${name} failed: ${r.stderr.trim()}`);
  }

  async function ensureOwnedVolume(name: string): Promise<void> {
    if (await ownedResourceExists("volume", name)) return;
    const created = await dexec(["volume", "create", "--label", `qm.org=${orgId}`, name]);
    if (created.code !== 0 && !(await ownedResourceExists("volume", name))) {
      throw new Error(`docker volume create ${name} failed: ${created.stderr.trim()}`);
    }
    if (!(await ownedResourceExists("volume", name))) {
      throw new Error(`docker volume create ${name} did not create an inspectable owned volume`);
    }
  }

  async function removeNetwork(name: string): Promise<void> {
    const net = localNetworkName(name);
    if (opts.controllerContainer) {
      const disconnected = await dexec(["network", "disconnect", "-f", net, opts.controllerContainer]);
      if (
        disconnected.code !== 0 &&
        !resourceIsMissing("network", disconnected.stderr) &&
        !resourceIsMissing("container", disconnected.stderr) &&
        !/is not connected to network/iu.test(disconnected.stderr)
      ) {
        throw new Error(`docker network disconnect ${net} failed: ${disconnected.stderr.trim()}`);
      }
      controllerNetworks.delete(net);
    }
    const removed = await dexec(["network", "rm", net]);
    if (removed.code !== 0 && !resourceIsMissing("network", removed.stderr)) {
      throw new Error(`docker network rm ${net} failed: ${removed.stderr.trim()}`);
    }
  }

  async function runContainer(name: string, scope: string | undefined, withVolume: boolean): Promise<void> {
    const net = await ensureNetwork(name);
    const args = [
      "run",
      "-d",
      "--platform",
      LOCAL_SANDBOX_PLATFORM,
      "--name",
      name,
      "--label",
      "qm.sandbox=1",
      ...(scope ? ["--label", `qm.scope=${scope}`] : []),
      "--label",
      `qm.org=${orgId}`,
      "--label",
      `qm.sandbox-platform=${LOCAL_SANDBOX_PLATFORM}`,
      "--label",
      `agent_env=${environment}`,
      "--network",
      net,
      ...(withVolume && scope ? ["-v", `${localVolumeName(scope, orgId)}:${homeDir}`] : []),
      ...(opts.controllerContainer ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`]),
      "--add-host=host.docker.internal:host-gateway",
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    portByName.delete(name);
    await connectController(name);
    await waitDaemon(name);
  }

  async function ensureContainer(scope: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const name = localContainerName(scope, orgId);
      scopeByContainer.set(name, scope);
      const destroyMarker = localDestroyMarkerName(scope, orgId);
      if (await ownedResourceExists("volume", destroyMarker)) {
        if (destroyRequested.has(name) && (activeByContainer.get(name) ?? 0) > 0) {
          throw new Error(`local sandbox ${name} has a pending destroy retry`);
        }
        destroyRequested.add(name);
        await removeContainer(name);
        await removeNetwork(name);
        await removeVolume(localVolumeName(scope, orgId));
        await removeVolume(localMigrationSentinelName(scope, orgId));
        await removeVolume(destroyMarker);
        destroyRequested.delete(name);
        scopeByContainer.delete(name);
        throw new Error(`local sandbox ${name} completed a pending destroy; provision must be retried`);
      }
      if (destroyRequested.has(name)) throw new Error(`local sandbox ${name} has a pending destroy retry`);
      const imageId = await preflight();
      const state = await containerState(name);
      if (state && state.imageId === imageId && state.platform === LOCAL_SANDBOX_PLATFORM) {
        if (!state.running) await startContainer(name);
        else await connectController(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await dexec(["rm", "-f", name]);
      const volume = localVolumeName(scope, orgId);
      const hadVolume = await ownedResourceExists("volume", volume);
      const legacyVolume = legacyLocalVolumeName(scope);
      const legacyInspection = await dexec(["volume", "inspect", legacyVolume]);
      if (legacyInspection.code !== 0 && !resourceIsMissing("volume", legacyInspection.stderr)) {
        throw new Error(`docker volume inspect ${legacyVolume} failed: ${legacyInspection.stderr.trim()}`);
      }
      const legacyExists = legacyInspection.code === 0;
      if (legacyExists) {
        const sentinel = localMigrationSentinelName(scope, orgId);
        const migrationComplete = await ownedResourceExists("volume", sentinel);
        const legacyContainer = legacyLocalContainerName(scope);
        const legacyState = await dexec([
          "inspect",
          "-f",
          '{{.State.Running}} {{.Id}} {{range .Mounts}}{{if eq .Destination "/root"}}{{.Name}}{{end}}{{end}}',
          legacyContainer,
        ]);
        if (legacyState.code !== 0 && !resourceIsMissing("container", legacyState.stderr)) {
          throw new Error(`docker container inspect ${legacyContainer} failed: ${legacyState.stderr.trim()}`);
        }
        const [legacyRunning, legacyContainerId, legacyMountedVolume] = legacyState.stdout.trim().split(/\s+/);
        if (legacyState.code === 0 && legacyMountedVolume !== legacyVolume) {
          throw new Error(
            `legacy local sandbox container ${legacyContainer} does not anchor expected volume ${legacyVolume}`,
          );
        }
        if (legacyState.code === 0 && legacyRunning === "true") {
          throw new Error(
            `legacy local sandbox container ${legacyContainer} is running; stop it before migration: docker stop ${shq(legacyContainer)}`,
          );
        }
        if (hadVolume && !migrationComplete) {
          throw new Error(
            `legacy local sandbox migration is incomplete; remove the destination before retrying: docker volume rm ${shq(volume)}`,
          );
        }
        if (!hadVolume && migrationComplete) {
          throw new Error(
            `legacy local sandbox migration marker ${sentinel} has no destination; remove it before retrying: docker volume rm ${shq(sentinel)}`,
          );
        }
        if (hadVolume && migrationComplete) {
          if (legacyState.code === 0) {
            throw new Error(
              `legacy local sandbox migration completion cannot be trusted while container ${legacyContainer} remains; remove the destination and marker before retrying: docker volume rm ${shq(volume)} ${shq(sentinel)}`,
            );
          }
          throw new Error(
            `legacy local sandbox migration copy is complete but the old home remains; retire it before continuing: docker volume rm ${shq(legacyVolume)}`,
          );
        }
        if (!hadVolume) {
          if (legacyState.code !== 0 || !legacyContainerId) {
            throw new Error(
              `legacy local sandbox volume ${legacyVolume} has no legacy container anchor; automatic migration is refused`,
            );
          }
          if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
            throw new Error(
              `legacy local sandbox volume ${legacyVolume} requires a digest-pinned LOCAL_SANDBOX_IMAGE before migration`,
            );
          }
          const create = `docker volume create --label ${shq(`qm.org=${orgId}`)} ${shq(volume)}`;
          const copy = `docker run --platform ${LOCAL_SANDBOX_PLATFORM} --rm --network none --entrypoint sh --volumes-from ${shq(`${legacyContainerId}:ro`)} -v ${shq(`${volume}:/to`)} ${shq(image)} -c ${shq("cp -a /root/. /to/")}`;
          const closeWriter = `docker rm ${shq(legacyContainerId)}`;
          const complete = `docker volume create --label ${shq(`qm.org=${orgId}`)} ${shq(sentinel)}`;
          const retire = `docker volume rm ${shq(legacyVolume)}`;
          const cleanup = `docker volume rm ${shq(volume)} ${shq(sentinel)}`;
          throw new Error(
            `legacy local sandbox volume ${legacyVolume} must be migrated before continuing: ${create} && (${copy} && ${closeWriter} && ${complete} && ${retire} || { ${cleanup}; exit 1; })`,
          );
        }
      }
      if (!hadVolume) {
        await ensureOwnedVolume(volume);
      }
      await runContainer(name, scope, true);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: !hadVolume };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(`scratch:${key}`, async () => {
      await preflight();
      const name = localScratchName(key, orgId);
      if (destroyRequested.has(name)) throw new Error(`local sandbox ${name} has a pending destroy retry`);
      scratchByKey.set(key, name);
      const state = await containerState(name);
      if (state) {
        if (!activeByContainer.has(name)) {
          await removeContainer(name);
          await removeNetwork(name);
          await runContainer(name, undefined, false);
          activeByContainer.set(name, 1);
          return { name, coldStart: true };
        }
        if (!state.running) await startContainer(name);
        else await connectController(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      await runContainer(name, undefined, false);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: true };
    });
  }

  function teardownQueueKey(handle: SandboxHandle): string {
    if (handle.scratch) {
      for (const [k, name] of scratchByKey) if (name === handle.id) return `scratch:${k}`;
      return handle.id;
    }
    return scopeByContainer.get(handle.id) ?? handle.id;
  }

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: `Debian 12 (bookworm), glibc — local Docker container on a trusted single-tenant ${arch()} host`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execBackup = createExecBackup({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const body = scratch ? await ensureScratch(scratch.key) : await ensureContainer(scope);
      const name = body.name;

      const env = provOpts?.env && Object.keys(provOpts.env).length ? provOpts.env : undefined;
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      try {
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`, 30);
        if (prep.code !== 0) throw new Error(`local sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "local" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("local-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("local-sandbox: kill in-flight exec", undefined));
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(teardownQueueKey(handle), async () => {
        const scope = scopeByContainer.get(handle.id);
        if (!handle.scratch && tdOpts?.destroy) {
          if (!scope) throw new Error(`local sandbox ${handle.id} has no scope for durable destroy`);
          await ensureOwnedVolume(localDestroyMarkerName(scope, orgId));
          destroyRequested.add(handle.id);
        }
        if (handle.scratch && tdOpts?.destroy) destroyRequested.add(handle.id);
        if (!releasedHandles.has(handle)) {
          const remaining = (activeByContainer.get(handle.id) ?? 1) - 1;
          releasedHandles.add(handle);
          if (remaining > 0) {
            activeByContainer.set(handle.id, remaining);
            return;
          }
          activeByContainer.delete(handle.id);
        } else if ((activeByContainer.get(handle.id) ?? 0) > 0) {
          return;
        }
        const destructive = handle.scratch || destroyRequested.has(handle.id);

        if (handle.scratch) {
          await removeContainer(handle.id);
          await removeNetwork(handle.id);
          for (const [k, name] of scratchByKey) if (name === handle.id) scratchByKey.delete(k);
          destroyRequested.delete(handle.id);
          portByName.delete(handle.id);
          return;
        }

        if (tdOpts?.keepWarm && !destructive) return;

        if (destructive) {
          await removeContainer(handle.id);
          await removeNetwork(handle.id);
          if (scope) await removeVolume(localVolumeName(scope, orgId));
          if (scope) await removeVolume(localMigrationSentinelName(scope, orgId));
          if (scope) await removeVolume(localDestroyMarkerName(scope, orgId));
          scopeByContainer.delete(handle.id);
          destroyRequested.delete(handle.id);
          portByName.delete(handle.id);
          return;
        }

        const r = await dexec(["stop", "-t", "2", handle.id], 60_000);
        if (r.code !== 0)
          opts.onError?.({
            category: "sandbox_park",
            code: "docker_stop_failed",
            message: r.stderr.trim(),
            ...(scopeByContainer.get(handle.id) ? { scopeLabel: scopeByContainer.get(handle.id)! } : {}),
          });
        portByName.delete(handle.id);
      });
    },
  };

  return sandbox;
}
