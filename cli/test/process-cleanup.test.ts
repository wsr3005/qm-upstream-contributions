import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { runTrackedChild } from "../src/process-cleanup.ts";

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("tracked children unregister signal cleanup after normal, failing, and spawn-error exits", async () => {
  const baseline = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  assert.deepEqual(await runTrackedChild(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" }), {
    code: 0,
    signal: null,
  });
  assert.deepEqual(await runTrackedChild(process.execPath, ["--eval", "process.exit(7)"], { stdio: "ignore" }), {
    code: 7,
    signal: null,
  });
  await assert.rejects(
    () => runTrackedChild(join(tmpdir(), "qm-missing-executable"), [], { stdio: "ignore" }),
    /ENOENT/,
  );
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], baseline);
});

for (const scenario of [
  { name: "docker build", signal: "SIGTERM", args: ["build", "--tag", "test", "."] },
  { name: "docker buildx push", signal: "SIGINT", args: ["buildx", "build", "--push", "."] },
] as const) {
  test(`${scenario.signal} stops the ${scenario.name} process tree before contexts and leases are released`, async () => {
    const root = mkdtempSync(join(tmpdir(), "qm-process-cleanup-"));
    const pluginDir = join(root, "plugins", "example");
    const marker = join(root, "prepared-path");
    const childReady = join(root, "child-ready");
    const sideEffect = join(root, "side-effect");
    const processIds = join(root, "process-ids");
    const awsLog = join(root, "aws.log");
    const awsBin = join(root, "aws");
    const dockerBin = join(root, "docker");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "Dockerfile"), "FROM scratch\n");
    writeFileSync(
      awsBin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QM_TEST_AWS_LOG, args.join(" ") + "\\n");
if (args.includes("delete-item")) {
  const context = fs.readFileSync(process.env.QM_TEST_MARKER, "utf8");
  const pids = fs.readFileSync(process.env.QM_TEST_PROCESS_IDS, "utf8").split(" ").map(Number);
  const alive = pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  fs.appendFileSync(process.env.QM_TEST_AWS_LOG, "release-state context=" + fs.existsSync(context) + " children=" + alive + "\\n");
}
`,
    );
    chmodSync(awsBin, 0o755);
    writeFileSync(
      dockerBin,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
        `setTimeout(() => require("node:fs").writeFileSync(process.env.QM_TEST_SIDE_EFFECT, "late\n"), 750); setInterval(() => undefined, 1000);`,
      )}], { stdio: "ignore", env: process.env });
fs.writeFileSync(process.env.QM_TEST_PROCESS_IDS, process.pid + " " + grandchild.pid);
fs.writeFileSync(process.env.QM_TEST_CHILD_READY, process.argv.slice(2).join(" "));
setTimeout(() => fs.writeFileSync(process.env.QM_TEST_SIDE_EFFECT, "late\\n"), 750);
setInterval(() => undefined, 1000);
`,
    );
    chmodSync(dockerBin, 0o755);
    const script = `
import { writeFileSync } from "node:fs";
import { acquireAwsLease } from ${JSON.stringify(new URL("../src/aws-lease.ts", import.meta.url).href)};
import { withSourcePluginBuildContextAsync } from ${JSON.stringify(new URL("../src/plugin-build-context.ts", import.meta.url).href)};
import { runInheritAsync } from ${JSON.stringify(new URL("../src/util.ts", import.meta.url).href)};
const plugin = JSON.parse(process.env.QM_TEST_PLUGIN);
acquireAwsLease({ accountId: "123456789012", region: "us-west-2", cluster: "cleanup-test", deployRoleArn: "arn:test", imageLabel: "test", secretsPrefix: "test/", networking: { cloudMapNamespace: "test.internal" }, services: {} });
await withSourcePluginBuildContextAsync(plugin, async (prepared) => {
  writeFileSync(process.env.QM_TEST_MARKER, prepared.directory);
  await runInheritAsync(process.env.QM_TEST_DOCKER, JSON.parse(process.env.QM_TEST_DOCKER_ARGS));
});
`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        AWS_BIN: awsBin,
        QM_TEST_CHILD_READY: childReady,
        QM_TEST_DOCKER: dockerBin,
        QM_TEST_DOCKER_ARGS: JSON.stringify(scenario.args),
        QM_TEST_AWS_LOG: awsLog,
        QM_TEST_MARKER: marker,
        QM_TEST_PROCESS_IDS: processIds,
        QM_TEST_SIDE_EFFECT: sideEffect,
        QM_TEST_PLUGIN: JSON.stringify({
          name: "example",
          kind: "source",
          sourceDir: pluginDir,
          dockerfile: join(pluginDir, "Dockerfile"),
          env: {},
        }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    let prepared = "";
    try {
      await waitForFile(marker);
      try {
        await waitForFile(childReady);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${stderr}`);
      }
      prepared = readFileSync(marker, "utf8");
      assert.equal(existsSync(prepared), true);
      assert.equal(readFileSync(childReady, "utf8"), scenario.args.join(" "));
      child.kill(scenario.signal);
      const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      assert.equal(code, null);
      assert.equal(signal, scenario.signal);
      assert.equal(existsSync(prepared), false);
      const commands = readFileSync(awsLog, "utf8");
      assert.match(commands, /dynamodb put-item/);
      assert.match(commands, /dynamodb delete-item/);
      assert.match(commands, /release-state context=false children=false/);
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
      if (prepared && basename(prepared).startsWith("qm-plugin-build-")) {
        rmSync(prepared, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
