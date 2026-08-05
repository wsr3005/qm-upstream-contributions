import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "test-signing-secret".repeat(3);

function start(): { base: string; app: ReturnType<typeof buildApp>["app"]; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "claim-")) }));
  const server = createServer(built.app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, app: built.app, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

async function fetchPending(base: string, query: string): Promise<{ id: string }[]> {
  const path = `/v1/deliveries?${query}`;
  const res = await fetch(`${base}${path}`, { headers: sign("GET", path, "") });
  assert.equal(res.status, 200);
  return ((await res.json()) as { deliveries?: { id: string }[] }).deliveries ?? [];
}

async function signedPost(base: string, path: string, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  return fetch(`${base}${path}`, { method: "POST", headers: sign("POST", path, body), body });
}

test("two overlapping drain pollers with claimMs can't both receive the same delivery", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "group", target: "C1:171.001" },
      text: "reply enqueued mid-deploy",
      idempotencyKey: "post:sess-1:one",
    });
    const [oldTask, newTask] = await Promise.all([
      fetchPending(srv.base, "type=group&claimMs=15000"),
      fetchPending(srv.base, "type=group&claimMs=15000"),
    ]);
    assert.equal(oldTask.length + newTask.length, 1, "exactly one poller receives the row");
  } finally {
    await srv.close();
  }
});

test("a claim-less fetch stays claim-agnostic (the web-ui drain re-reads rows it left unacked)", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "web", target: "web:owner:thread" },
      text: "nudge",
      idempotencyKey: "post:sess-2:one",
    });
    assert.equal((await fetchPending(srv.base, "type=web")).length, 1);
    assert.equal((await fetchPending(srv.base, "type=web")).length, 1, "still visible on the next poll");
  } finally {
    await srv.close();
  }
});

test("an expired claim re-surfaces the row to a later poll (drainer died mid-post)", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "group", target: "C2" },
      text: "claimed then abandoned",
      idempotencyKey: "post:sess-3:one",
    });
    assert.equal((await fetchPending(srv.base, "type=group&claimMs=50")).length, 1);
    assert.equal(
      (await fetchPending(srv.base, "type=group&claimMs=50")).length,
      0,
      "claimed rows are invisible before the TTL",
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await fetchPending(srv.base, "type=group&claimMs=15000")).length, 1, "the abandoned row comes back");
  } finally {
    await srv.close();
  }
});

test("a source can renew and terminally resolve only its current delivery claim", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "office", target: "member-a" },
      text: "scheduled result",
      idempotencyKey: "post:sess-4:one",
    });
    const first = (await fetchPending(srv.base, "type=office&claimMs=50"))[0] as {
      id: string;
      claim: { token: string };
    };
    assert.ok(first.claim.token);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const current = (await fetchPending(srv.base, "type=office&claimMs=15000"))[0] as {
      id: string;
      claim: { token: string };
    };
    assert.notEqual(current.claim.token, first.claim.token);

    const stale = await signedPost(srv.base, `/v1/deliveries/${first.id}/claim/resolve?nonce=stale`, {
      claimToken: first.claim.token,
      outcome: "delivered",
    });
    assert.equal(stale.status, 409);

    const renewed = await signedPost(srv.base, `/v1/deliveries/${current.id}/claim/renew?nonce=renew`, {
      claimToken: current.claim.token,
      claimMs: 15_000,
    });
    assert.equal(renewed.status, 200);

    const resolved = await signedPost(srv.base, `/v1/deliveries/${current.id}/claim/resolve?nonce=resolve`, {
      claimToken: current.claim.token,
      outcome: "failed",
      failureCode: "recipient_unauthorized",
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), { outcome: "resolved" });

    const duplicate = await signedPost(srv.base, `/v1/deliveries/${current.id}/claim/resolve?nonce=retry`, {
      claimToken: current.claim.token,
      outcome: "failed",
      failureCode: "recipient_unauthorized",
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { outcome: "duplicate" });
    assert.deepEqual(await fetchPending(srv.base, "type=office"), []);
  } finally {
    await srv.close();
  }
});
