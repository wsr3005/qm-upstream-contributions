import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { queueTurn, type TurnOptions } from "../src/core-bridge.ts";
import { assertProductReservationTarget, parseProductReservation } from "../src/product-reservation.ts";

const valid = {
  schemaVersion: "qm-model-test-product-reservation-v2",
  runAlias: "base-acceptance-01",
  candidateCommit: "a".repeat(40),
  requestId: "product-pi-01",
  harness: "pi",
  model: "enterprise-responses/gpt-5.6-luna",
  upstreamModelId: "gpt-5.6-luna",
  modelProviderId: "enterprise-responses",
  modelProviderRevision: 7,
  idempotencyKey: `qa-${"b".repeat(64)}`,
  principalCorrelation: "hmac-0123456789abcdef",
};

test("a product reservation is parsed only when every identity field is internally consistent", () => {
  const parsed = parseProductReservation(JSON.stringify(valid));
  assert.deepEqual(parsed, valid);
  assert.doesNotThrow(() =>
    assertProductReservationTarget(parsed, {
      harness: "pi",
      model: "enterprise-responses/gpt-5.6-luna",
    }),
  );
});

test("malformed, extended, mismatched and weak reservations are rejected", () => {
  const invalid = [
    "not json",
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, candidateCommit: "short" }),
    JSON.stringify({ ...valid, modelProviderRevision: 0 }),
    JSON.stringify({ ...valid, idempotencyKey: "qa-readable" }),
    JSON.stringify({ ...valid, principalCorrelation: "raw-user" }),
    JSON.stringify({ ...valid, modelProviderId: "another-provider" }),
  ];
  for (const input of invalid) assert.throws(() => parseProductReservation(input));
  const parsed = parseProductReservation(JSON.stringify(valid));
  assert.throws(() => assertProductReservationTarget(parsed, { harness: "codex", model: parsed.model }));
  assert.throws(() =>
    assertProductReservationTarget(parsed, { harness: parsed.harness, model: "enterprise-responses/gpt-5.6-sol" }),
  );
});

test("the authenticated composer imports, reads back, binds and consumes one reservation", () => {
  const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
  assert.match(composer, /Formal acceptance reservation/);
  for (const field of [
    "schemaVersion",
    "runAlias",
    "candidateCommit",
    "requestId",
    "harness",
    "model",
    "upstreamModelId",
    "modelProviderId",
    "modelProviderRevision",
    "idempotencyKey",
    "principalCorrelation",
  ]) {
    assert.match(composer, new RegExp(`reservation\\.${field}`));
  }
  assert.match(chat, /\.\.\.ctx\.composer\.formalTurnOptions\(\)/);
  assert.match(bridge, /idempotencyKey: turnOptions\.idempotencyKey/);
  assert.match(bridge, /modelProviderId: turnOptions\.modelProviderId/);
  assert.match(bridge, /modelProviderRevision: turnOptions\.modelProviderRevision/);
  assert.equal((bridge.match(/turnOptions\.reservationAccepted\?\.\(\);/g) ?? []).length, 2);
  assert.equal((bridge.match(/reservationRejected\?\.\(\);/g) ?? []).length, 2);
  assert.match(composer, /composerState\.productReservation !== reservation/);
  assert.match(composer, /composerState\.productReservation = null/);
  assert.match(composer, /!productReservationTargetError\(\)/);
  const contentReset = composer.slice(
    composer.indexOf("function resetComposerContent"),
    composer.indexOf("function resetComposer()"),
  );
  const conversationReset = composer.slice(
    composer.indexOf("function resetComposer()"),
    composer.indexOf("function scopeKey"),
  );
  assert.doesNotMatch(contentReset, /productReservation/);
  assert.match(conversationReset, /productReservationInFlight = null/);
  const send = composer.slice(
    composer.indexOf("async function sendPrompt"),
    composer.indexOf("const LARGE_PASTE_CHARS"),
  );
  assert.ok(send.indexOf("acquireProductReservation()") < send.indexOf("resetComposerContent();"));
  assert.ok(send.indexOf("stageTurnOptions(agent, turnOptions)") < send.indexOf("await agent.prompt"));
  assert.match(composer, /if \(!composerCanSend\(\)\) return;/);
  assert.match(composer, /!composerState\.productReservationInFlight/);
  assert.match(chat, /makeOpenerStreamFn\(threadRef, agent, nonFormalTurnOptions/);
  assert.match(chat, /runApprovalTurn\([\s\S]{0,180}?nonFormalTurnOptions/);
  const drive = bridge.slice(bridge.indexOf("async function drive"), bridge.indexOf("async function resumeDrive"));
  assert.ok(drive.indexOf("turnOptions = getTurnOptions?.()") < drive.indexOf("await latestUserTurn(agent)"));
});

test("an accepted client turn forwards and consumes the exact reservation once", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ runId: "run-reserved" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let accepted = 0;
  const options: TurnOptions = {
    harness: valid.harness,
    idempotencyKey: valid.idempotencyKey,
    modelProviderId: valid.modelProviderId,
    modelProviderRevision: valid.modelProviderRevision,
    reservationAccepted: () => accepted++,
  };
  const agent = {
    state: {
      model: { id: valid.model, api: "openai-responses", provider: valid.modelProviderId },
      thinkingLevel: "low",
    },
  } as unknown as Agent;
  const queued = await queueTurn("web:qa:reserved", "test", agent, () => options);
  assert.equal(queued.runId, "run-reserved");
  assert.equal(body?.idempotencyKey, valid.idempotencyKey);
  assert.equal(body?.modelProviderId, valid.modelProviderId);
  assert.equal(body?.modelProviderRevision, valid.modelProviderRevision);
  assert.equal(body?.harness, valid.harness);
  assert.equal(body?.model, valid.model);
  assert.equal(accepted, 1);
});

test("a rejected client turn preserves the reservation for an exact retry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "conflict" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  let accepted = 0;
  let rejected = 0;
  const agent = {
    state: { model: { id: valid.model, api: "openai-responses", provider: valid.modelProviderId } },
  } as unknown as Agent;
  await assert.rejects(() =>
    queueTurn("web:qa:reserved", "test", agent, () => ({
      harness: valid.harness,
      idempotencyKey: valid.idempotencyKey,
      modelProviderId: valid.modelProviderId,
      modelProviderRevision: valid.modelProviderRevision,
      reservationAccepted: () => accepted++,
      reservationRejected: () => rejected++,
    })),
  );
  assert.equal(accepted, 0);
  assert.equal(rejected, 1);
});
