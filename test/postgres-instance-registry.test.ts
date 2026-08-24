import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresInstanceRegistry } from "../src/runs/instance-registry.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the instance-registry tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS instance_heartbeats CASCADE");
  await p.end();
});

test(
  "supersession: a newer different-sha instance drains the old one; same sha and stale beats don't",
  { skip },
  async () => {
    const pool = createPostgresMapFactory(URL!).pool;
    const capable = createPostgresInstanceRegistry(pool, {
      instanceId: "i-capable",
      buildSha: "sha-capable",
      startedAt: 500,
      livenessMs: 200,
      incompatibleGraceMs: 400,
      capabilities: ["wire-id-v1"],
    });
    assert.equal(await capable.allLiveSupport!("wire-id-v1"), false, "zero rows never prove rollout readiness");
    await capable.beat();
    const firstCapable = await capable.capabilitySnapshot!("wire-id-v1");
    assert.equal(
      await capable.allLiveSupport!("wire-id-v1"),
      true,
      "the current capable instance must heartbeat first",
    );
    await capable.beat();
    assert.equal(
      (await capable.capabilitySnapshot!("wire-id-v1")).epoch,
      firstCapable.epoch,
      "routine heartbeats do not move the rollout fence",
    );

    const old = createPostgresInstanceRegistry(pool, {
      instanceId: "i-old",
      buildSha: "sha-a",
      startedAt: 1000,
      livenessMs: 200,
      incompatibleGraceMs: 400,
    });
    assert.equal(await old.beat(), false, "alone: not superseded");

    const peer = createPostgresInstanceRegistry(pool, {
      instanceId: "i-peer",
      buildSha: "sha-a",
      startedAt: 2000,
      livenessMs: 200,
      incompatibleGraceMs: 400,
    });
    await peer.beat();
    assert.equal(await old.beat(), false, "same-sha peer (scale-out) never drains");

    const next = createPostgresInstanceRegistry(pool, {
      instanceId: "i-new",
      buildSha: "sha-b",
      startedAt: 3000,
      livenessMs: 200,
      incompatibleGraceMs: 400,
      capabilities: ["wire-id-v1"],
    });
    await next.beat();
    const mixed = await next.capabilitySnapshot!("wire-id-v1");
    assert.equal(await old.beat(), true, "newer build live: superseded");
    assert.equal(await next.beat(), false, "the newest build itself is not superseded");
    assert.equal(await next.allLiveSupport!("wire-id-v1"), false, "a live old runtime blocks the capability");
    assert.notEqual(mixed.epoch, firstCapable.epoch, "a new instance moves the rollout fence");

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await old.beat(), false, "the newer build's beats went stale (failed deploy): claiming resumes");
    assert.equal(await next.allLiveSupport!("wire-id-v1"), false, "the refreshed old runtime still blocks activation");
    await new Promise((r) => setTimeout(r, 250));
    await next.beat();
    assert.equal(
      await next.allLiveSupport!("wire-id-v1"),
      false,
      "an incompatible runtime keeps blocking after normal liveness while traffic drains",
    );
    await new Promise((r) => setTimeout(r, 200));
    await next.beat();
    assert.equal(await next.allLiveSupport!("wire-id-v1"), true, "only capable live runtimes allow activation");
    const readyAgain = await next.capabilitySnapshot!("wire-id-v1");
    await new Promise((r) => setTimeout(r, 250));
    await old.beat();
    const resumedOld = await next.capabilitySnapshot!("wire-id-v1");
    assert.equal(resumedOld.ready, false, "a resumed incompatible instance closes activation again");
    assert.notEqual(resumedOld.epoch, readyAgain.epoch, "a stale-to-live transition moves the rollout fence");
  },
);
