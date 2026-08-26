import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createCustomProviderTestRunStore,
  customProviderTestRequestFingerprint,
  type CustomProviderTestRunIdentity,
  type StoredCustomProviderTestRun,
} from "../src/model/custom-provider-test-runs.ts";

const IDENTITY: CustomProviderTestRunIdentity = {
  scopeId: "org:acme",
  providerId: "gateway",
  modelId: "luna",
  harnessId: "pi",
  providerRevision: 3,
  rolloutFence: "epoch-7",
};

test("formal reservations extend fingerprints without invalidating legacy paid-test receipts", () => {
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        IDENTITY.scopeId,
        IDENTITY.providerId,
        IDENTITY.modelId,
        IDENTITY.harnessId,
        IDENTITY.providerRevision,
        IDENTITY.rolloutFence,
        null,
      ]),
    )
    .digest("hex");
  assert.equal(customProviderTestRequestFingerprint(IDENTITY), legacyFingerprint);
  assert.notEqual(
    customProviderTestRequestFingerprint({ ...IDENTITY, reservationFingerprint: "signed-reservation" }),
    legacyFingerprint,
  );
});

test("custom provider paid tests admit one owner and replay its durable result", async () => {
  const now = 1_000;
  let owner = 0;
  const store = createCustomProviderTestRunStore({
    backing: createMemoryMap<StoredCustomProviderTestRun>(),
    advisoryLock: createMemoryAdvisoryLock(),
    now: () => now,
    ownerId: () => `owner-${++owner}`,
    runningTtlMs: 100,
    resultTtlMs: 200,
  });
  assert.equal(store.durable, false);

  const first = await store.claim(IDENTITY, "request-a");
  assert.ok(first.kind === "claimed");
  const duplicate = await store.claim(IDENTITY, "request-b");
  assert.deepEqual(duplicate, {
    kind: "running",
    retryAfterMs: 100,
    replayExpected: true,
    requestExpiresAt: 1_200,
  });
  const rolloutChanged = await store.claim({ ...IDENTITY, providerRevision: 4, rolloutFence: "epoch-8" }, "request-c");
  assert.deepEqual(rolloutChanged, { kind: "running", retryAfterMs: 100, replayExpected: false });
  const requestChanged = await store.claim({ ...IDENTITY, harnessId: "codex" }, "request-a");
  assert.deepEqual(requestChanged, { kind: "conflict" });
  assert.equal(
    await store.complete(first, {
      status: 200,
      body: { ok: true, reply: "ready" },
    }),
    true,
  );

  const replay = await store.claim(IDENTITY, "request-a");
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.response.body, { ok: true, reply: "ready" });
    assert.equal(replay.completedAt, 1_000);
    assert.equal(replay.expiresAt, 1_200);
  }
  const changedReplay = await store.claim({ ...IDENTITY, providerRevision: 4, rolloutFence: "epoch-8" }, "request-a");
  assert.deepEqual(changedReplay, { kind: "conflict" });

  const sharedReplay = await store.claim(IDENTITY, "request-b");
  assert.equal(sharedReplay.kind, "replay");
  const renewed = await store.claim(IDENTITY, "request-d");
  assert.equal(renewed.kind, "claimed");
  assert.notEqual(renewed.kind === "claimed" ? renewed.owner : "", first.owner);
});

test("a waiter near lease expiry cannot reuse its request id for a second paid call", async () => {
  let now = 1_000;
  const store = createCustomProviderTestRunStore({
    backing: createMemoryMap<StoredCustomProviderTestRun>(),
    advisoryLock: createMemoryAdvisoryLock(),
    now: () => now,
    runningTtlMs: 100,
    resultTtlMs: 100,
  });
  assert.equal((await store.claim(IDENTITY, "request-owner")).kind, "claimed");
  now = 1_099;
  const waiter = await store.claim(IDENTITY, "request-waiter");
  assert.deepEqual(waiter, {
    kind: "running",
    retryAfterMs: 1,
    replayExpected: true,
    requestExpiresAt: 1_199,
  });

  now = 1_101;
  assert.deepEqual(await store.claim(IDENTITY, "request-waiter"), {
    kind: "unresolved",
    retryAfterMs: 98,
    requestExpiresAt: 1_199,
  });
  assert.deepEqual(await store.claim(IDENTITY, "request-fresh-tab"), {
    kind: "unresolved",
    retryAfterMs: 98,
    requestExpiresAt: 1_199,
  });
  now = 1_200;
  assert.equal((await store.claim(IDENTITY, "request-fresh-tab")).kind, "claimed");
});

test("custom provider paid test expiry cannot delete or complete a replacement owner", async () => {
  let now = 10;
  const backing = createMemoryMap<StoredCustomProviderTestRun>();
  const store = createCustomProviderTestRunStore({
    backing,
    advisoryLock: createMemoryAdvisoryLock(),
    now: () => now,
    ownerId: () => `owner-${now}`,
    runningTtlMs: 10,
    resultTtlMs: 10,
  });

  const stale = await store.claim(IDENTITY, "request-stale");
  now = 21;
  const current = await store.claim(IDENTITY, "request-current");
  assert.ok(stale.kind === "claimed");
  assert.ok(current.kind === "claimed");
  assert.equal(
    await store.complete(stale, {
      status: 200,
      body: { reply: "stale" },
    }),
    false,
  );
  assert.equal(await store.sweep(), 0);
  now = 32;
  assert.equal(await store.sweep(), 2);
  assert.deepEqual(await backing.all(), [{ active: {}, receipts: {} }]);
});

test("custom provider paid test completion is one durable state transition", async () => {
  const memory = createMemoryMap<StoredCustomProviderTestRun>();
  let throwAfterPut = false;
  const store = createCustomProviderTestRunStore({
    backing: {
      ...memory,
      async put(id, value) {
        await memory.put(id, value);
        if (throwAfterPut) throw new Error("response lost after commit");
      },
    },
    advisoryLock: createMemoryAdvisoryLock(),
  });
  const claim = await store.claim(IDENTITY, "request-ambiguous");
  assert.ok(claim.kind === "claimed");
  throwAfterPut = true;
  await assert.rejects(
    store.complete(claim, { status: 200, body: { ok: true, reply: "ready" } }),
    /response lost after commit/,
  );
  throwAfterPut = false;
  const replay = await store.claim(IDENTITY, "request-ambiguous");
  assert.equal(replay.kind, "replay");
});

test("a paid-test owner claim recovers only when an ambiguous put committed", async () => {
  const memory = createMemoryMap<StoredCustomProviderTestRun>();
  let failure: "before" | "after" | null = "after";
  const store = createCustomProviderTestRunStore({
    backing: {
      ...memory,
      async put(id, value) {
        if (failure === "before") throw new Error("failed before commit");
        await memory.put(id, value);
        if (failure === "after") throw new Error("response lost after commit");
      },
    },
    advisoryLock: createMemoryAdvisoryLock(),
    ownerId: () => "owner-ambiguous-claim",
  });

  assert.equal((await store.claim(IDENTITY, "request-committed")).kind, "claimed");
  failure = "before";
  await assert.rejects(store.claim({ ...IDENTITY, harnessId: "codex" }, "request-not-committed"), /before commit/);
  failure = null;
  assert.equal((await store.claim({ ...IDENTITY, harnessId: "codex" }, "request-not-committed")).kind, "claimed");
});

test("a waiter claim recovers only when an ambiguous put committed", async () => {
  const memory = createMemoryMap<StoredCustomProviderTestRun>();
  let failure: "before" | "after" | null = null;
  const store = createCustomProviderTestRunStore({
    backing: {
      ...memory,
      async put(id, value) {
        if (failure === "before") throw new Error("failed before commit");
        await memory.put(id, value);
        if (failure === "after") throw new Error("response lost after commit");
      },
    },
    advisoryLock: createMemoryAdvisoryLock(),
  });
  const owner = await store.claim(IDENTITY, "request-owner");
  assert.ok(owner.kind === "claimed");
  failure = "before";
  await assert.rejects(store.claim(IDENTITY, "request-waiter-before"), /before commit/);
  assert.equal(Object.keys((await memory.all())[0]?.receipts ?? {}).length, 1);
  failure = null;
  assert.equal((await store.claim(IDENTITY, "request-waiter-before")).kind, "running");
  failure = "after";
  assert.equal((await store.claim(IDENTITY, "request-waiter-after")).kind, "running");
  failure = null;
  assert.equal(await store.complete(owner, { status: 200, body: { reply: "ready" } }), true);
  assert.equal((await store.claim(IDENTITY, "request-waiter-before")).kind, "replay");
  assert.equal((await store.claim(IDENTITY, "request-waiter-after")).kind, "replay");
});
