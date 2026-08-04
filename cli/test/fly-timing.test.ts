import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(cliDir, "..");
const bin = join(cliDir, "bin", "qm.ts");

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function fakeFlyBin(dir: string): string {
  const binPath = join(dir, "fake-fly.cjs");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cmd = args.join(" ");
if (process.env.FAKE_FLY_LOG) fs.appendFileSync(process.env.FAKE_FLY_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_FLY_BLOCK && args[0] === "deploy") {
  const { spawn } = require("node:child_process");
  const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
    `setTimeout(() => require("node:fs").writeFileSync(process.env.FAKE_FLY_SIDE_EFFECT, "late\n"), 750); setInterval(() => undefined, 1000);`,
  )}], { stdio: "ignore", env: process.env });
  fs.writeFileSync(process.env.FAKE_FLY_PROCESS_IDS, process.pid + " " + grandchild.pid);
  fs.writeFileSync(process.env.FAKE_FLY_READY, JSON.stringify(args));
  setTimeout(() => fs.writeFileSync(process.env.FAKE_FLY_SIDE_EFFECT, "late\\n"), 750);
  setInterval(() => undefined, 1000);
}
if (process.env.FAKE_FLY_CONTEXT_LOG && args[0] === "deploy" && args.includes("--dockerfile")) {
  const context = args.at(-1);
  const dockerfile = args[args.indexOf("--dockerfile") + 1];
  const ignorefile = args[args.indexOf("--ignorefile") + 1];
  if (!args.includes("--ignorefile") || !ignorefile) process.exit(43);
  const dockerIgnore = require(${JSON.stringify(join(cliDir, "node_modules", "@balena", "dockerignore"))});
  const matcher = dockerIgnore({ ignorecase: false }).add(fs.readFileSync(ignorefile, "utf8"));
  const archived = (path) => fs.existsSync(context + "/" + path) && !matcher.ignores(path);
  fs.writeFileSync(process.env.FAKE_FLY_CONTEXT_LOG, JSON.stringify({
    context,
    dockerfile,
    ignorefile,
    pluginSource: archived("src/index.mjs") ? fs.readFileSync(context + "/src/index.mjs", "utf8") : null,
    chassis: archived("plugins/chassis/src/core-client.ts"),
    ignoredSecret: archived("ignored-secret"),
    rootSecret: archived("root-secret"),
    specificSecret: archived("specific-secret"),
  }));
}
if (args[0] === "apps" && args[1] === "create") {
  console.log("created");
} else if (args[0] === "secrets" && args[1] === "set") {
  console.log("staged");
} else if (args[0] === "secrets" && args[1] === "list") {
  console.log("ADMIN_GRANTS\\nANTHROPIC_API_KEY\\nAWS_ACCESS_KEY_ID\\nAWS_ENDPOINT_URL_S3\\nAWS_SECRET_ACCESS_KEY\\nCAPABILITY_SECRET\\nCONNECTOR_SECRET_KEY\\nCORE_SIGNING_SECRET\\nPORTAL_IDENTITY_SECRET\\nSKILL_SIGNING_SECRET\\nFLY_API_TOKEN\\nPUBLIC_API_URL\\n" + (process.env.FAKE_FLY_FRESH_PG ? "" : "DATABASE_URL\\n") + "SLACK_BOT_TOKEN\\nSLACK_APP_TOKEN");
} else if (args[0] === "mpg" && args[1] === "list") {
  console.log(process.env.FAKE_FLY_FRESH_PG ? "" : "pg-1 test-pg");
} else if (args[0] === "mpg" && args[1] === "create") {
  console.log("ID: pg-1");
} else if (args[0] === "mpg" && args[1] === "status") {
  if (process.env.FAKE_FLY_STATUS_FAIL) {
    console.log("postgresql://fly-user:secret@direct.pg-1.flympg.net/fly-db");
    console.error("postgresql://fly-user:secret@direct.pg-1.flympg.net/fly-db");
    process.exit(1);
  }
  console.log(JSON.stringify({ credentials: { pgbouncer_uri: "postgresql://fly-user:secret@pgbouncer.pg-1.flympg.net/fly-db" } }));
} else if (args[0] === "status" && args.includes("--json")) {
  console.log(JSON.stringify({ Machines: [{ id: "machine-core", config: { image: "registry.fly.io/source-core:v1" } }] }));
} else if (args[0] === "image" && args[1] === "show") {
  console.log(process.env.FAKE_FLY_NO_IMAGE_DIGEST ? "[]" : JSON.stringify([
    ...(process.env.FAKE_FLY_MIXED_IMAGES ? [{ MachineID: "machine-other", Registry: "registry.fly.io", Repository: "source-core", Tag: "v1", Digest: "sha256:${"b".repeat(64)}" }] : []),
    { MachineID: "machine-core", Registry: "registry.fly.io", Repository: "source-core", Tag: "v1", Digest: "sha256:${"a".repeat(64)}" },
  ]));
} else if (args[0] === "deploy") {
  console.log("deployed");
} else if (args[0] === "ssh" && args[1] === "console") {
  console.log('QM_LAYER_RESPONSE=' + JSON.stringify({ status: 200, body: JSON.stringify({ version: 1, contentHash: "0123456789abcdef" }) }));
} else {
  console.error("unexpected fake fly command: " + cmd);
  process.exit(42);
}

`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

test("Fly source plugin deploys use a prepared root context and remove it after flyctl exits", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-plugin-context-"));
  const pluginDir = join(dir, "plugins", "example");
  const contextLog = join(dir, "context.json");
  mkdirSync(join(pluginDir, "src"), { recursive: true });
  writeFileSync(
    join(pluginDir, "Dockerfile"),
    "FROM scratch\nCOPY src /app/src\nCOPY plugins/chassis /plugins/chassis\n",
  );
  writeFileSync(join(pluginDir, "src", "index.mjs"), 'export const plugin = "example";\n');
  writeFileSync(join(pluginDir, ".dockerignore"), "plugins/*\nignored-secret\n");
  writeFileSync(join(pluginDir, "ignored-secret"), "secret\n");
  const configPath = join(dir, "qm.config.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      contract: 1,
      orgId: "plugin-context",
      publicUrl: "https://example.invalid",
      target: "fly",
      flyOrg: "personal",
      region: "sjc",
      services: ["core"],
      plugins: [{ name: "example" }],
      skills: [],
      env: {
        core: {
          SNAPSHOT_STORE: "s3",
          TRANSFER_STORE: "s3",
          S3_BUCKET: "plugin-context-data",
          S3_REGION: "auto",
        },
      },
      imageOverrides: {},
      sandbox: { app: "plugin-context-sandboxes" },
    }),
  );
  try {
    const result = spawnSync(process.execPath, [bin, "up", "--config", configPath, "--only", "example"], {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_CONTEXT_LOG: contextLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(contextLog, "utf8")) as {
      context: string;
      dockerfile: string;
      ignorefile: string;
      pluginSource: string;
      chassis: boolean;
      ignoredSecret: boolean;
    };
    assert.equal(dirname(recorded.dockerfile), recorded.context);
    assert.match(basename(recorded.dockerfile), /^\.qm-plugin-.+\.Dockerfile$/);
    assert.equal(recorded.ignorefile, `${recorded.dockerfile}.dockerignore`);
    assert.equal(recorded.pluginSource, 'export const plugin = "example";\n');
    assert.equal(recorded.chassis, true);
    assert.equal(recorded.ignoredSecret, false);
    assert.equal(existsSync(recorded.context), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fly source plugin build-only uses Dockerfile-specific ignore precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-plugin-build-context-"));
  const pluginDir = join(dir, "plugins", "example");
  const contextLog = join(dir, "context.json");
  mkdirSync(join(pluginDir, "src"), { recursive: true });
  writeFileSync(
    join(pluginDir, "Dockerfile"),
    "FROM scratch\nCOPY src /app/src\nCOPY plugins/chassis /plugins/chassis\nCOPY root-secret /app/root-secret\n",
  );
  writeFileSync(join(pluginDir, "src", "index.mjs"), 'export const plugin = "example";\n');
  writeFileSync(join(pluginDir, ".dockerignore"), "root-secret\n");
  writeFileSync(join(pluginDir, "Dockerfile.dockerignore"), "plugins/*\nspecific-secret\n");
  writeFileSync(join(pluginDir, "root-secret"), "included\n");
  writeFileSync(join(pluginDir, "specific-secret"), "excluded\n");
  const configPath = join(dir, "qm.config.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      contract: 1,
      orgId: "plugin-build-context",
      publicUrl: "https://example.invalid",
      target: "fly",
      flyOrg: "personal",
      region: "sjc",
      services: ["core"],
      plugins: [{ name: "example" }],
      skills: [],
      env: {
        core: {
          SNAPSHOT_STORE: "s3",
          TRANSFER_STORE: "s3",
          S3_BUCKET: "plugin-build-context-data",
          S3_REGION: "auto",
        },
      },
      imageOverrides: {},
      sandbox: { app: "plugin-build-context-sandboxes" },
    }),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [bin, "up", "--config", configPath, "--only", "example", "--build-only", "--image-label", "test"],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: {
          ...process.env,
          FLY_BIN: fakeFlyBin(dir),
          FAKE_FLY_CONTEXT_LOG: contextLog,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(contextLog, "utf8")) as {
      context: string;
      dockerfile: string;
      ignorefile: string;
      chassis: boolean;
      rootSecret: boolean;
      specificSecret: boolean;
    };
    assert.equal(recorded.ignorefile, `${recorded.dockerfile}.dockerignore`);
    assert.equal(recorded.chassis, true);
    assert.equal(recorded.rootSecret, true);
    assert.equal(recorded.specificSecret, false);
    assert.equal(existsSync(recorded.context), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "ordinary deploy", signal: "SIGTERM", extraArgs: [] },
  { name: "build-only deploy", signal: "SIGINT", extraArgs: ["--build-only", "--image-label", "test"] },
] as const) {
  test(`${scenario.signal} stops the Fly source plugin ${scenario.name} process tree`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-fly-plugin-signal-"));
    const pluginDir = join(dir, "plugins", "example");
    const ready = join(dir, "ready.json");
    const sideEffect = join(dir, "side-effect");
    const processIds = join(dir, "process-ids");
    mkdirSync(join(pluginDir, "src"), { recursive: true });
    writeFileSync(join(pluginDir, "Dockerfile"), "FROM scratch\nCOPY plugins/chassis /plugins/chassis\n");
    writeFileSync(join(pluginDir, "src", "index.mjs"), 'export const plugin = "example";\n');
    const configPath = join(dir, "qm.config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "plugin-signal",
        publicUrl: "https://example.invalid",
        target: "fly",
        flyOrg: "personal",
        region: "sjc",
        services: ["core"],
        plugins: [{ name: "example" }],
        skills: [],
        env: {
          core: {
            SNAPSHOT_STORE: "s3",
            TRANSFER_STORE: "s3",
            S3_BUCKET: "plugin-signal-data",
            S3_REGION: "auto",
          },
        },
        imageOverrides: {},
        sandbox: { app: "plugin-signal-sandboxes" },
      }),
    );
    const child = spawn(
      process.execPath,
      [bin, "up", "--config", configPath, "--only", "example", ...scenario.extraArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FLY_BIN: fakeFlyBin(dir),
          FAKE_FLY_BLOCK: "1",
          FAKE_FLY_PROCESS_IDS: processIds,
          FAKE_FLY_READY: ready,
          FAKE_FLY_SIDE_EFFECT: sideEffect,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    try {
      await waitForFile(ready);
      const args = JSON.parse(readFileSync(ready, "utf8")) as string[];
      const context = args.at(-1)!;
      assert.equal(existsSync(context), true);
      assert.equal(
        args.includes("--build-only"),
        scenario.extraArgs.some((arg) => arg === "--build-only"),
      );
      child.kill(scenario.signal);
      const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      assert.equal(code, null);
      assert.equal(signal, scenario.signal);
      assert.equal(existsSync(context), false);
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(existsSync(sideEffect), false);
      for (const pid of readFileSync(processIds, "utf8").split(" ").map(Number)) {
        assert.throws(() => process.kill(pid, 0));
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (existsSync(processIds)) {
        for (const pid of readFileSync(processIds, "utf8").split(" ").map(Number)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            void 0;
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("fly up emits phase timings and appends a GitHub step summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-timing-"));
  const summaryPath = join(dir, "summary.md");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /timing qm\/core: app ensure \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: secret checks \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: Postgres ensure \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: current image lookup \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: fly deploy \d+(?:ms|\.\d+s)/);

  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /### Fly deploy timings \(qm\)/);
  assert.match(summary, /\| Stack \| Service \| Phase \| Duration \|/);
  assert.match(summary, /\| qm \| core \| app ensure \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| secret checks \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| Postgres ensure \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| current image lookup \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| fly deploy \| \d+(?:ms|\.\d+s) \|/);
});

test("fly up can deploy a tagged image without consulting the source stack's running image", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-tagged-"));
  const logPath = join(dir, "fly.log");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "cli", "test", "fixtures", "imagefrom-stack.json"),
      "--only",
      "core",
      "--image-label",
      "sha123",
      "--image-repo-prefix",
      "qm",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /--image registry\.fly\.io\/qm-core:sha123/);
  assert.doesNotMatch(stdout, /current image lookup/);
  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === "status"),
    false,
  );
  assert.equal(
    commands.some(
      (args) => args[0] === "deploy" && args.includes("--image") && args.includes("registry.fly.io/qm-core:sha123"),
    ),
    true,
  );
});

test("fly image-from fails closed when Fly cannot resolve the running tag to a digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-no-digest-"));
  const result = spawnSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_NO_IMAGE_DIGEST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source-core did not report an immutable image digest/);
  assert.doesNotMatch(result.stdout, /fly deploy/);
});

test("fly image-from resolves by machine id during a mixed rollout", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-mixed-images-"));
  const logPath = join(dir, "fly.log");
  execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
        FAKE_FLY_MIXED_IMAGES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const deploy = commands.find((args) => args[0] === "deploy");
  assert.ok(deploy?.includes(`registry.fly.io/source-core@sha256:${"a".repeat(64)}`));
  assert.equal(deploy?.includes(`registry.fly.io/source-core@sha256:${"b".repeat(64)}`), false);
});

test("a fresh Fly deploy stages the direct Managed Postgres URL without attaching the pooled URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-fresh-pg-"));
  const logPath = join(dir, "fly.log");
  execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
        FAKE_FLY_FRESH_PG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const directSecret = commands.findIndex(
    (args) => args[0] === "secrets" && args[1] === "set" && args.includes("DATABASE_URL=-"),
  );
  const deploy = commands.findIndex((args) => args[0] === "deploy");
  assert.ok(directSecret >= 0, "the direct DATABASE_URL is staged");
  assert.ok(deploy > directSecret, "the direct DATABASE_URL is staged before the first deploy");
  assert.equal(
    commands.some((args) => args[0] === "mpg" && args[1] === "attach"),
    false,
  );
});

test("Fly preserves an existing DATABASE_URL even when a same-name Managed Postgres cluster exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-existing-db-"));
  const logPath = join(dir, "fly.log");
  execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === "mpg"),
    false,
  );
  assert.equal(
    commands.some((args) => args[0] === "secrets" && args[1] === "set" && args.includes("DATABASE_URL=-")),
    false,
  );
});

test("Fly redacts credential-bearing Managed Postgres status failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-pg-error-"));
  const result = spawnSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_FRESH_PG: "1",
        FAKE_FLY_STATUS_FAIL: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to read Managed Postgres connection details/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fly-user|secret@|flympg\.net/);
});

test("fly up build-only pushes a tagged image without checking runtime deploy secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-build-only-"));
  const logPath = join(dir, "fly.log");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--build-only",
      "--image-label",
      "sha123",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /--build-only --push --image-label sha123/);
  assert.match(stdout, /image: qm-core -> registry\.fly\.io\/qm-core:sha123/);
  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === "secrets" && args[1] === "list"),
    false,
  );
  assert.equal(
    commands.some((args) => args[0] === "secrets" && args[1] === "set"),
    true,
    "new apps receive only the ownership marker",
  );
  assert.equal(
    commands.some(
      (args) =>
        args[0] === "deploy" &&
        args.includes("--build-only") &&
        args.includes("--push") &&
        args.includes("--image-label"),
    ),
    true,
  );
});

test("fly up build-only dry-run plans without pushing an image", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-build-only-dry-run-"));
  const logPath = join(dir, "fly.log");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--build-only",
      "--image-label",
      "sha123",
      "--dry-run",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /Plan only\. Re-run without --dry-run to build images\./);
  assert.equal(existsSync(logPath), false);
});
