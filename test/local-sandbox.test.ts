import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSandbox,
  localDestroyMarkerName,
  legacyLocalContainerName,
  legacyLocalVolumeName,
  localContainerName,
  localMigrationSentinelName,
  localNetworkName,
  localVolumeName,
} from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";

const tmp = mkdtempSync(join(tmpdir(), "local-sbx-"));
const guestHome = join(tmp, "home");
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeDocker, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  return createLocalSandbox(createLocalWorkspaceStore(dir), {
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

test("profile declares the local Docker substrate honestly", () => {
  const sb = makeSandbox(installFakeDocker(daemonPort));
  assert.equal(sb.profile.backend, "local-docker");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("a containerized Core reaches each sandbox on an isolated shared network", async () => {
  const fake = installFakeDocker(daemonPort);
  const requested: string[] = [];
  const sb = makeSandbox(fake, {
    controllerContainer: "qm-acme-core",
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(input));
      return fetch(String(input).replace(/http:\/\/[^:]+:8080/u, `http://127.0.0.1:${daemonPort}`), init);
    },
  });
  const handle = await sb.provision(rw(scopeId("personal", "U-container")));
  const network = localNetworkName(handle.id);
  assert.equal(requested.length > 0, true);
  assert.equal(
    requested.every((url) => url.startsWith(`http://${handle.id}:8080`)),
    true,
  );
  assert.equal(fake.networkConnections.get(network)?.has("qm-acme-core"), true);
  await sb.teardown(handle, { destroy: true });
  assert.equal(fake.networkConnections.has(network), false);
});

test("two organizations never reuse one another's local container or volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "shared-user");
  const first = makeSandbox(fake, { orgId: "org-a" });
  const second = makeSandbox(fake, { orgId: "org-b" });
  const firstHandle = await first.provision(rw(scope));
  const secondHandle = await second.provision(rw(scope));
  assert.notEqual(firstHandle.id, secondHandle.id);
  assert.equal(fake.runCount, 2);
  assert.notEqual(fake.containers.get(firstHandle.id)?.volume, fake.containers.get(secondHandle.id)?.volume);
  assert.equal(fake.containers.get(firstHandle.id)?.labels["qm.org"], "org-a");
  assert.equal(fake.containers.get(secondHandle.id)?.labels["qm.org"], "org-b");
  await first.teardown(firstHandle, { destroy: true });
  await second.teardown(secondHandle, { destroy: true });
});

test("organization isolation names resist a known historical 24-bit hash collision", () => {
  const scope = scopeId("personal", "shared-user");
  const firstOrg = `${"a".repeat(40)}-3n`;
  const secondOrg = `${"a".repeat(40)}-33x`;
  assert.notEqual(localContainerName(scope, firstOrg), localContainerName(scope, secondOrg));
  assert.notEqual(localVolumeName(scope, firstOrg), localVolumeName(scope, secondOrg));
});

test("a colliding local container with a mismatched ownership label is rejected", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "owned-user");
  const name = localContainerName(scope, "org-a");
  fake.containers.set(name, {
    name,
    imageId: fake.imageId,
    running: true,
    labels: { "qm.org": "org-b" },
  });
  const sandbox = makeSandbox(fake, { orgId: "org-a" });
  await assert.rejects(sandbox.provision(rw(scope)), /belongs to org-b/);
  assert.equal(fake.runCount, 0);
});

test("a colliding local network with a mismatched ownership label is rejected", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "network-owner");
  const network = localNetworkName(localContainerName(scope, "org-a"));
  fake.networks.add(network);
  fake.networkOwners.set(network, "org-b");
  fake.networkConnections.set(network, new Set());
  const sandbox = makeSandbox(fake, { orgId: "org-a" });
  await assert.rejects(sandbox.provision(rw(scope)), /network .* belongs to org-b/);
  assert.equal(fake.runCount, 0);
});

test("a colliding local volume with a mismatched ownership label is rejected", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "volume-owner");
  const volume = localVolumeName(scope, "org-a");
  fake.volumes.add(volume);
  fake.volumeOwners.set(volume, "org-b");
  const sandbox = makeSandbox(fake, { orgId: "org-a" });
  await assert.rejects(sandbox.provision(rw(scope)), /volume .* belongs to org-b/);
  assert.equal(fake.runCount, 0);
});

test("a transient legacy volume inspection failure cannot create an empty replacement", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "inspect-failure-user");
  const legacyVolume = legacyLocalVolumeName(scope);
  fake.volumes.add(legacyVolume);
  fake.inspectFailures.set(legacyVolume, "authorization plugin denied volume inspection");
  const sandbox = makeSandbox(fake, { orgId: "upgraded-org" });
  await assert.rejects(sandbox.provision(rw(scope)), /docker volume inspect .* failed: authorization plugin denied/);
  assert.equal(fake.volumes.has(localVolumeName(scope, "upgraded-org")), false);
  assert.equal(fake.runCount, 0);
});

test("a successful volume create is re-inspected for ownership before container start", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "create-race-user");
  fake.volumeCreateOwnerOverride = "other-org";
  const sandbox = makeSandbox(fake, { orgId: "upgraded-org" });
  await assert.rejects(sandbox.provision(rw(scope)), /belongs to other-org/);
  assert.equal(fake.runCount, 0);
});

test("an orphaned legacy local volume refuses automatic migration", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-user");
  const legacy = legacyLocalVolumeName(scope);
  fake.volumes.add(legacy);
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId: "upgraded-org",
  });
  await assert.rejects(sandbox.provision(rw(scope)), /has no legacy container anchor; automatic migration is refused/);
  assert.equal(fake.volumes.has(localVolumeName(scope, "upgraded-org")), false);
  assert.equal(fake.runCount, 0);
});

test("a stopped legacy container anchors the source volume by immutable container id", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "stopped-legacy-user");
  const legacyContainer = legacyLocalContainerName(scope);
  fake.volumes.add(legacyLocalVolumeName(scope));
  fake.containers.set(legacyContainer, {
    name: legacyContainer,
    imageId: fake.imageId,
    running: false,
    labels: {},
    volume: legacyLocalVolumeName(scope),
  });
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId: "upgraded-org",
  });
  await assert.rejects(sandbox.provision(rw(scope)), (error: Error) => {
    assert.match(error.message, new RegExp(`--volumes-from '${fake.imageId}:ro'`));
    assert.match(error.message, /--network none/);
    assert.match(error.message, /cp -a \/root\/\. \/to\//);
    assert.doesNotMatch(error.message, new RegExp(`${legacyLocalVolumeName(scope)}:/from`));
    assert.match(error.message, new RegExp(`docker rm '${fake.imageId}' && docker volume create`));
    return true;
  });
  assert.equal(fake.volumes.has(localVolumeName(scope, "upgraded-org")), false);
  assert.equal(fake.runCount, 0);
});

test("a running legacy container must stop before its volume can be migrated", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "live-legacy-user");
  const legacyContainer = legacyLocalContainerName(scope);
  fake.volumes.add(legacyLocalVolumeName(scope));
  fake.containers.set(legacyContainer, {
    name: legacyContainer,
    imageId: fake.imageId,
    running: true,
    labels: {},
    volume: legacyLocalVolumeName(scope),
  });
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId: "upgraded-org",
  });
  await assert.rejects(sandbox.provision(rw(scope)), /is running; stop it before migration: docker stop/);
  assert.equal(fake.runCount, 0);
});

test("an interrupted legacy migration cannot expose a partial destination", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "interrupted-legacy-user");
  const orgId = "upgraded-org";
  const destination = localVolumeName(scope, orgId);
  fake.volumes.add(legacyLocalVolumeName(scope));
  fake.volumes.add(destination);
  fake.volumeOwners.set(destination, orgId);
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId,
  });
  await assert.rejects(sandbox.provision(rw(scope)), /migration is incomplete; remove the destination/);
  assert.equal(fake.volumes.has(localMigrationSentinelName(scope, orgId)), false);
  assert.equal(fake.runCount, 0);
});

test("a completed legacy migration reuses its organization-owned destination", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "completed-legacy-user");
  const orgId = "upgraded-org";
  const destination = localVolumeName(scope, orgId);
  const sentinel = localMigrationSentinelName(scope, orgId);
  fake.volumes.add(destination);
  fake.volumes.add(sentinel);
  fake.volumeOwners.set(destination, orgId);
  fake.volumeOwners.set(sentinel, orgId);
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId,
  });
  const handle = await sandbox.provision(rw(scope));
  assert.equal(handle.coldStart, false);
  assert.equal(fake.containers.get(handle.id)?.volume, destination);
  await sandbox.teardown(handle, { destroy: true });
  assert.equal(fake.volumes.has(destination), false);
  assert.equal(fake.volumes.has(sentinel), false);
});

test("a copied migration cannot proceed until its old home is retired", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "unretired-legacy-user");
  const orgId = "upgraded-org";
  const destination = localVolumeName(scope, orgId);
  const sentinel = localMigrationSentinelName(scope, orgId);
  fake.volumes.add(legacyLocalVolumeName(scope));
  fake.volumes.add(destination);
  fake.volumes.add(sentinel);
  fake.volumeOwners.set(destination, orgId);
  fake.volumeOwners.set(sentinel, orgId);
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId,
  });
  await assert.rejects(sandbox.provision(rw(scope)), /copy is complete but the old home remains; retire it/);
  assert.equal(fake.runCount, 0);
});

test("a migration marker cannot retire a volume while its legacy writer still exists", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "untrusted-completion-user");
  const orgId = "upgraded-org";
  const legacyVolume = legacyLocalVolumeName(scope);
  const legacyContainer = legacyLocalContainerName(scope);
  const destination = localVolumeName(scope, orgId);
  const sentinel = localMigrationSentinelName(scope, orgId);
  fake.volumes.add(legacyVolume);
  fake.volumes.add(destination);
  fake.volumes.add(sentinel);
  fake.volumeOwners.set(destination, orgId);
  fake.volumeOwners.set(sentinel, orgId);
  fake.containers.set(legacyContainer, {
    name: legacyContainer,
    imageId: fake.imageId,
    running: false,
    labels: {},
    volume: legacyVolume,
  });
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId,
  });
  await assert.rejects(sandbox.provision(rw(scope)), /completion cannot be trusted.*remove the destination and marker/);
  assert.equal(fake.runCount, 0);
});

test("a same-named legacy container that does not mount the old home is refused", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "wrong-anchor-user");
  const legacyContainer = legacyLocalContainerName(scope);
  fake.volumes.add(legacyLocalVolumeName(scope));
  fake.containers.set(legacyContainer, {
    name: legacyContainer,
    imageId: fake.imageId,
    running: false,
    labels: {},
    volume: "different-volume",
  });
  const sandbox = makeSandbox(fake, {
    image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
    orgId: "upgraded-org",
  });
  await assert.rejects(sandbox.provision(rw(scope)), /does not anchor expected volume/);
  assert.equal(fake.runCount, 0);
});

test("a stopped Docker daemon fails provision with the actionable message", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.daemonDown = true;
  const sb = makeSandbox(fake);
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U0"))),
    /requires a running Docker daemon \(is Docker Desktop running\?\)/,
  );
});

test("a missing sandbox image fails provision with the build hint", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.imageMissing = true;
  const sb = makeSandbox(fake);
  await assert.rejects(sb.provision(rw(scopeId("personal", "U0"))), /not found — run `npm run sandbox:local:build`/);
});

test("cold provision creates volume + container, run() execs over the daemon, bytes round-trip", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U1");
  const h = await sb.provision(rw(scope));
  assert.equal(h.id, localContainerName(scope));
  assert.equal(h.rootDir, `${guestHome}/workspace`);
  assert.equal(h.homeDir, guestHome);
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  const c = fake.containers.get(h.id)!;
  assert.equal(c.labels["qm.sandbox"], "1");
  assert.equal(c.labels["qm.scope"], scope);
  assert.equal(c.labels["qm.org"], "default-org");
  assert.equal(c.labels["agent_env"], "dev");
  assert.equal(c.volume, localVolumeName(scope));

  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  await sb.writeFileBytes(h, "bin/blob.dat", payload);
  assert.deepEqual(Uint8Array.from((await sb.readFileBytes(h, "bin/blob.dat"))!), payload);
  assert.equal(await sb.readFileBytes(h, "bin/missing.dat"), null);
});

test("production local sandboxes are outside dev-instance cleanup", async () => {
  const fake = installFakeDocker(daemonPort);
  const sandbox = makeSandbox(fake, { environment: "production", orgId: "production-org" });
  const handle = await sandbox.provision(rw(scopeId("personal", "production-user")));
  assert.equal(fake.containers.get(handle.id)?.labels["agent_env"], "production");
  await sandbox.teardown(handle, { destroy: true });
});

test("teardown parks the container and the next provision restarts it warm", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, h1.id, "same container reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new container run");
  assert.equal(fake.containers.get(h1.id)!.running, true, "restarted");
});

test("a stale-image container is recreated while its home volume survives", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await makeSandbox(fake).provision(layers);
  const volume = fake.containers.get(h1.id)!.volume!;

  fake.imageId = "sha256:image-v2";
  const h2 = await makeSandbox(fake).provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 2, "container recreated on the new image");
  assert.equal(fake.containers.get(h2.id)!.imageId, "sha256:image-v2");
  assert.equal(fake.volumes.has(volume), true, "volume survived the recreate");
  assert.equal(h2.coldStart, false, "existing volume means a warm home");
});

test("a scratch box has no volume and is removed on teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U4")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  assert.equal(fake.containers.get(h.id)!.volume, undefined);
  await sb.teardown(h);
  assert.equal(fake.containers.has(h.id), false, "scratch container destroyed");
});

test("scratch cleanup failure is reported and can be retried", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "scratch-cleanup-failure")), {
    scratch: { key: "owner-auth-cleanup" },
  });
  fake.commandFailures.set(["rm", "-f", h.id].join("\0"), ["authorization denied"]);
  await assert.rejects(sb.teardown(h, { destroy: true }), /docker container rm .* failed: authorization denied/);
  assert.equal(fake.containers.has(h.id), true);
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
});

test("a pending scratch destroy rejects reuse and retry never consumes a new reference", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "scratch-pending-destroy"));
  const options = { scratch: { key: "owner-auth-pending" } };
  const h = await sb.provision(layers, options);
  fake.commandFailures.set(["rm", "-f", h.id].join("\0"), ["authorization denied"]);
  await assert.rejects(sb.teardown(h, { destroy: true }), /authorization denied/);
  await assert.rejects(sb.provision(layers, options), /pending destroy retry/);
  await sb.teardown(h, { destroy: true });
  const replacement = await sb.provision(layers, options);
  assert.equal(fake.containers.has(replacement.id), true);
  await sb.teardown(replacement, { destroy: true });
});

test("a scratch container orphaned by an earlier process is replaced before reuse", async () => {
  const fake = installFakeDocker(daemonPort);
  const first = makeSandbox(fake);
  const second = makeSandbox(fake);
  const layers = rw(scopeId("personal", "scratch-orphan"));
  const options = { scratch: { key: "orphaned-owner-auth" } };
  const orphan = await first.provision(layers, options);
  const previousRuns = fake.runCount;
  const replacement = await second.provision(layers, options);
  assert.equal(replacement.id, orphan.id);
  assert.equal(replacement.coldStart, true);
  assert.equal(fake.runCount, previousRuns + 1);
  await second.teardown(replacement, { destroy: true });
});

test("teardown destroy removes both the container and its volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U5");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("destroy reports a container removal failure and leaves later resources intact for retry", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "destroy-failure");
  const h = await sb.provision(rw(scope));
  fake.commandFailures.set(["rm", "-f", h.id].join("\0"), ["authorization denied"]);
  await assert.rejects(sb.teardown(h, { destroy: true }), /docker container rm .* failed: authorization denied/);
  assert.equal(fake.containers.has(h.id), true);
  assert.equal(fake.networks.has(localNetworkName(h.id)), true);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("a pending resident destroy is completed before reprovision can create a replacement", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "resident-pending-destroy");
  const layers = rw(scope);
  const h = await sb.provision(layers);
  fake.commandFailures.set(["rm", "-f", h.id].join("\0"), ["authorization denied"]);
  await assert.rejects(sb.teardown(h, { destroy: true }), /authorization denied/);
  await assert.rejects(sb.provision(layers), /completed a pending destroy/);
  const replacement = await sb.provision(layers);
  assert.equal(fake.containers.has(replacement.id), true);
  await sb.teardown(replacement, { destroy: true });
});

test("restart recovery retries a transient cleanup failure in the same Core process", async () => {
  const fake = installFakeDocker(daemonPort);
  const orgId = "restart-retry-org";
  const first = makeSandbox(fake, { orgId });
  const scope = scopeId("personal", "restart-retry-failure");
  const layers = rw(scope);
  const h = await first.provision(layers);
  fake.commandFailures.set(["rm", "-f", h.id].join("\0"), ["first failure", "recovery failure"]);
  await assert.rejects(first.teardown(h, { destroy: true }), /first failure/);
  const restarted = makeSandbox(fake, { orgId });
  await assert.rejects(restarted.provision(layers), /recovery failure/);
  await assert.rejects(restarted.provision(layers), /completed a pending destroy/);
  const replacement = await restarted.provision(layers);
  assert.equal(replacement.coldStart, true);
  await restarted.teardown(replacement, { destroy: true });
});

test("a durable destroy marker resumes container cleanup after a Core restart", async () => {
  const fake = installFakeDocker(daemonPort);
  const orgId = "restart-container-org";
  const first = makeSandbox(fake, { orgId });
  const scope = scopeId("personal", "restart-container-failure");
  const layers = rw(scope);
  const h = await first.provision(layers);
  fake.commandFailures.set(["rm", "-f", h.id].join("\0"), ["daemon restart"]);
  await assert.rejects(first.teardown(h, { destroy: true }), /daemon restart/);
  assert.equal(fake.volumes.has(localDestroyMarkerName(scope, orgId)), true);
  const restarted = makeSandbox(fake, { orgId });
  await assert.rejects(restarted.provision(layers), /completed a pending destroy/);
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope, orgId)), false);
  assert.equal(fake.volumes.has(localDestroyMarkerName(scope, orgId)), false);
});

test("a durable destroy marker prevents volume reuse after a Core restart", async () => {
  const fake = installFakeDocker(daemonPort);
  const orgId = "restart-volume-org";
  const first = makeSandbox(fake, { orgId });
  const scope = scopeId("personal", "restart-volume-failure");
  const layers = rw(scope);
  const h = await first.provision(layers);
  const volume = localVolumeName(scope, orgId);
  fake.commandFailures.set(["volume", "rm", volume].join("\0"), ["volume store restart"]);
  await assert.rejects(first.teardown(h, { destroy: true }), /volume store restart/);
  assert.equal(fake.volumes.has(volume), true);
  const restarted = makeSandbox(fake, { orgId });
  await assert.rejects(restarted.provision(layers), /completed a pending destroy/);
  assert.equal(fake.volumes.has(volume), false);
  assert.equal(fake.volumes.has(localDestroyMarkerName(scope, orgId)), false);
});

test("restart recovery deletes pending data even when the configured image is gone", async () => {
  const fake = installFakeDocker(daemonPort);
  const orgId = "restart-missing-image-org";
  const first = makeSandbox(fake, { orgId });
  const scope = scopeId("personal", "restart-missing-image");
  const layers = rw(scope);
  const h = await first.provision(layers);
  fake.commandFailures.set(["volume", "rm", localVolumeName(scope, orgId)].join("\0"), ["volume unavailable"]);
  await assert.rejects(first.teardown(h, { destroy: true }), /volume unavailable/);
  fake.imageMissing = true;
  const restarted = makeSandbox(fake, { orgId });
  await assert.rejects(restarted.provision(layers), /completed a pending destroy/);
  assert.equal(fake.volumes.has(localVolumeName(scope, orgId)), false);
  assert.equal(fake.volumes.has(localDestroyMarkerName(scope, orgId)), false);
});

test("the first destroy request persists until the last resident reference is released", async () => {
  for (const destroyFirst of [true, false]) {
    const fake = installFakeDocker(daemonPort);
    const orgId = `multi-ref-${destroyFirst}`;
    const sb = makeSandbox(fake, { orgId });
    const scope = scopeId("personal", `multi-ref-${destroyFirst}`);
    const layers = rw(scope);
    const [first, second] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
    const sentinel = localMigrationSentinelName(scope, orgId);
    fake.volumes.add(sentinel);
    fake.volumeOwners.set(sentinel, orgId);
    if (destroyFirst) {
      await sb.teardown(first, { destroy: true });
      await sb.teardown(second);
    } else {
      await sb.teardown(first);
      await sb.teardown(second, { destroy: true });
    }
    assert.equal(fake.containers.has(first.id), false);
    assert.equal(fake.volumes.has(localVolumeName(scope, orgId)), false);
    assert.equal(fake.volumes.has(sentinel), false);
    assert.equal(fake.volumes.has(localDestroyMarkerName(scope, orgId)), false);
  }
});

test("a persisted destroy request overrides keepWarm on the last release", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "destroy-before-keep-warm");
  const layers = rw(scope);
  const [first, second] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(first, { destroy: true });
  await sb.teardown(second, { keepWarm: true });
  assert.equal(fake.containers.has(first.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("an explicit destroy overrides keepWarm in the same teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "destroy-with-keep-warm");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true, keepWarm: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("destroy retries safely after a volume removal failure", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "destroy-volume-failure");
  const h = await sb.provision(rw(scope));
  const volume = localVolumeName(scope);
  fake.commandFailures.set(["volume", "rm", volume].join("\0"), ["volume store unavailable"]);
  await assert.rejects(sb.teardown(h, { destroy: true }), /docker volume rm .* failed: volume store unavailable/);
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.networks.has(localNetworkName(h.id)), false);
  assert.equal(fake.volumes.has(volume), true);
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.volumes.has(volume), false);
});

test("destroy treats already absent resources as idempotent success", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "destroy-idempotent");
  const h = await sb.provision(rw(scope));
  fake.containers.delete(h.id);
  fake.networks.delete(localNetworkName(h.id));
  fake.networkConnections.delete(localNetworkName(h.id));
  fake.volumes.delete(localVolumeName(scope));
  await sb.teardown(h, { destroy: true });
});

test("concurrent provisions for one scope run a single container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U6"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("refcounted teardown: the container parks only after the last concurrent user releases", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(a);
  assert.equal(fake.containers.get(a.id)!.running, true, "still held by the sibling");
  await sb.teardown(b);
  assert.equal(fake.containers.get(b.id)!.running, false, "parked after the last release");
});

test("process sessions: start, read output, signal to exit", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  assert.ok(supportsProcessSessions(sb));
  const h = await sb.provision(rw(scopeId("personal", "U8")));
  const { processId } = await sb.startProcess!(h, "echo started; sleep 30");
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes("started")) {
    const r = await sb.readProcess!(h, processId, { waitMs: 200 });
    out += r.chunks;
  }
  assert.match(out, /started/);
  await sb.signalProcess!(h, processId, "TERM");
  let status = (await sb.readProcess!(h, processId, {})).status;
  const exitDeadline = Date.now() + 10_000;
  while (status.state !== "exited" && Date.now() < exitDeadline) {
    await sleep(200);
    status = (await sb.readProcess!(h, processId, {})).status;
  }
  assert.equal(status.state, "exited");
});

test("an aborted run returns control promptly", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U9")));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const startedAt = Date.now();
  await sb.run(h, "sleep 30", { signal: ctl.signal }).catch(() => {});
  assert.ok(Date.now() - startedAt < 5_000, "run returned promptly after abort");
});

test("read-only layers materialize into the workspace once per content fingerprint", async () => {
  const fake = installFakeDocker(daemonPort);
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const shared = scopeId("org", "default-org");
  await workspace.write(shared, "guide.md", "shared doc");
  const sb = createLocalSandbox(workspace, { dockerExec: fake.dockerExec, homeDir: guestHome, repoRoot: tmp });
  const h = await sb.provision([
    { scopeId: scopeId("personal", "U10"), mountPath: "", mode: "rw" as const },
    { scopeId: shared, mountPath: "shared", mode: "ro" as const },
  ]);
  assert.equal(await sb.readFile(h, "shared/guide.md"), "shared doc");
});

test("each container runs on its own network; destroy removes it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scopeA = scopeId("personal", "U20");
  const scopeB = scopeId("personal", "U21");
  const ha = await sb.provision(rw(scopeA));
  const hb = await sb.provision(rw(scopeB));
  const netA = localNetworkName(ha.id);
  const netB = localNetworkName(hb.id);
  assert.notEqual(netA, netB);
  assert.equal(fake.networks.has(netA), true);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(ha, { destroy: true });
  assert.equal(fake.networks.has(netA), false);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(hb);
});

test("concurrent teardown and provision for one scope serialize (no stop of a fresh user)", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U22");
  const h1 = await sb.provision(rw(scope));
  const [, h2] = await Promise.all([sb.teardown(h1), sb.provision(rw(scope))]);
  assert.equal(fake.containers.get(h2.id)!.running, true);
  const r = await sb.run(h2, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  await sb.teardown(h2);
  assert.equal(fake.containers.get(h2.id)!.running, false);
});
