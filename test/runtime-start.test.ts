import assert from "node:assert/strict";
import { test } from "node:test";
import { startRuntime } from "../src/runtime-start.ts";
import type { Runtime } from "../src/wiring.ts";

test("traffic stays closed until the first instance heartbeat succeeds", async () => {
  let releaseHeartbeat!: () => void;
  const heartbeat = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve;
  });
  let started = false;
  let listening = false;
  const runtime: Runtime = {
    ready: () => heartbeat,
    readyForTraffic: () => false,
    start: () => {
      started = true;
    },
    stop: async () => {},
    releaseInFlightRuns: async () => {},
  };
  const pending = startRuntime(runtime, () => {
    listening = true;
  });
  await Promise.resolve();
  assert.equal(started, false);
  assert.equal(listening, false);
  releaseHeartbeat();
  await pending;
  assert.equal(started, true);
  assert.equal(listening, true);
});

test("a failed first heartbeat keeps traffic closed", async () => {
  let started = false;
  let listening = false;
  const runtime: Runtime = {
    ready: async () => {
      throw new Error("heartbeat unavailable");
    },
    readyForTraffic: () => false,
    start: () => {
      started = true;
    },
    stop: async () => {},
    releaseInFlightRuns: async () => {},
  };
  await assert.rejects(
    startRuntime(runtime, () => {
      listening = true;
    }),
    /heartbeat unavailable/,
  );
  assert.equal(started, false);
  assert.equal(listening, false);
});
