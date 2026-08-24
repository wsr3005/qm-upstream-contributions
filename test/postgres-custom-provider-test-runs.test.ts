import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createCustomProviderTestRunStore } from "../src/model/custom-provider-test-runs.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the custom provider paid-test guard test";
const TABLE = "custom_provider_test_runs_it";

async function clean(): Promise<void> {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await pool.query("DELETE FROM durable_map_versions WHERE tbl = $1", [TABLE]).catch(() => undefined);
  await pool.end();
}

before(clean);
after(clean);

test("Postgres admits one paid-test owner across runtime instances and replays its result", { skip }, async () => {
  const firstFactory = createPostgresMapFactory(URL!);
  const secondFactory = createPostgresMapFactory(URL!);
  const first = createCustomProviderTestRunStore({
    backing: firstFactory.map(TABLE),
    advisoryLock: createPostgresAdvisoryLock(firstFactory.advisoryPool),
    durable: true,
  });
  const second = createCustomProviderTestRunStore({
    backing: secondFactory.map(TABLE),
    advisoryLock: createPostgresAdvisoryLock(secondFactory.advisoryPool),
    durable: true,
  });
  const identity = {
    scopeId: "org:acme",
    providerId: "gateway",
    modelId: "luna",
    harnessId: "codex",
    providerRevision: 8,
    rolloutFence: "epoch-2",
  };
  try {
    assert.equal(first.durable, true);
    const claims = await Promise.all([
      first.claim(identity, "request-first"),
      second.claim(identity, "request-second"),
    ]);
    assert.deepEqual(claims.map((claim) => claim.kind).sort(), ["claimed", "running"]);
    const owner = claims.find((claim) => claim.kind === "claimed");
    assert.ok(owner?.kind === "claimed");
    const rolloutChanged = await second.claim(
      { ...identity, providerRevision: 9, rolloutFence: "epoch-3" },
      "request-rollout-changed",
    );
    assert.equal(rolloutChanged.kind, "running");
    if (rolloutChanged.kind === "running") assert.equal(rolloutChanged.replayExpected, false);
    assert.equal(await first.complete(owner, { status: 200, body: { reply: "ready" } }), true);
    const replay = await second.claim(identity, owner.requestId);
    assert.equal(replay.kind, "replay");
    if (replay.kind === "replay") assert.deepEqual(replay.response.body, { reply: "ready" });
    const waiterRequestId = owner.requestId === "request-first" ? "request-second" : "request-first";
    assert.equal((await second.claim(identity, waiterRequestId)).kind, "replay");
    assert.equal(
      (await second.claim({ ...identity, providerRevision: 9, rolloutFence: "epoch-3" }, owner.requestId)).kind,
      "conflict",
    );
    const next = await second.claim(identity, "request-next");
    assert.equal(next.kind, "claimed");
    const independent = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        first.claim({ ...identity, providerId: `gateway-${index}` }, `request-parallel-${index}`),
      ),
    );
    assert.ok(independent.every((claim) => claim.kind === "claimed"));
  } finally {
    await Promise.all([
      firstFactory.pool.close(),
      firstFactory.advisoryPool.close(),
      secondFactory.pool.close(),
      secondFactory.advisoryPool.close(),
    ]);
  }
});
