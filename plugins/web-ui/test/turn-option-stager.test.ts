import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createTurnOptionStager } from "../src/turn-option-stager.ts";

const agent = {} as Agent;
const otherAgent = {} as Agent;

test("a staged explicit turn keeps its immutable reservation across delayed reads", () => {
  const stager = createTurnOptionStager();
  const reserved = {
    harness: "pi",
    modelProviderId: "enterprise-responses",
    modelProviderRevision: 7,
    idempotencyKey: `qa-${"a".repeat(64)}`,
  };
  stager.stage(agent, reserved);
  const currentComposer = {
    harness: "codex",
    modelProviderId: "another-provider",
    modelProviderRevision: 8,
  };
  assert.strictEqual(
    stager.take(agent, () => currentComposer),
    reserved,
  );
  assert.strictEqual(
    stager.take(agent, () => currentComposer),
    currentComposer,
  );
});

test("staged reservations cannot cross agents or replace non-formal fallback turns", () => {
  const stager = createTurnOptionStager();
  const reserved = { harness: "opencode", idempotencyKey: `qa-${"b".repeat(64)}` };
  const nonFormal = { harness: "pi" };
  stager.stage(agent, reserved);
  assert.strictEqual(
    stager.take(otherAgent, () => nonFormal),
    nonFormal,
  );
  assert.strictEqual(
    stager.take(agent, () => nonFormal),
    reserved,
  );
});
