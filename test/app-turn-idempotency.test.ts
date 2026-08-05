import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { buildWakeEnvelope } from "../src/core/wake-envelope.ts";
import { deduplicatedRunMatches } from "../src/runs/run-dedup.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";

const actor = { id: "internal:U1", type: "internal" as const };
const request: OrchestratorInput = {
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "execute once",
  approval: { requestId: "consumed-approval", approved: true, scope: "once" },
};

function addressedRequest({
  at = new Date(0),
  why = "The user addressed you.",
  recentMessage = "earlier context",
  instructions = "Act on the addressed message.",
}: {
  at?: Date;
  why?: string;
  recentMessage?: string;
  instructions?: string;
} = {}): OrchestratorInput {
  return {
    ...request,
    text: buildWakeEnvelope({
      reason: "addressed",
      surface: "slack",
      channel: "C1",
      at,
      why,
      recentMessages: [{ ts: "0.5", authorId: "internal:U2", text: recentMessage }],
      addressedMessages: [{ ts: "1.0", authorId: actor.id, text: "execute once" }],
      instructions,
    }),
    displayText: "execute once",
    envelopeWrapped: true,
  };
}

test("a completed approval request is found only for the same actor, scope and body", async () => {
  const { runs } = createMemoryRunStore();
  const enqueued = await runs.enqueue({ sessionId: "dm:U1:t1", request, dedupKey: "approval-response-retry" });
  const claimed = await runs.claimById(enqueued.run.id, "worker-a", 10_000);
  assert.ok(claimed?.leaseToken);
  await runs.complete(enqueued.run.id, claimed!.leaseToken!, { status: "ok", reply: "executed once" });

  const stored = await runs.getByDedupKey("approval-response-retry");
  assert.ok(stored);
  assert.equal(deduplicatedRunMatches(stored, "dm:U1:t1", request), true);
  assert.equal(await runs.getByDedupKey("missing"), null);
  assert.equal(deduplicatedRunMatches(stored, "dm:U1:other", request), false);
  assert.equal(
    deduplicatedRunMatches(stored, "dm:U1:t1", {
      ...request,
      actor: { id: "internal:U2", type: "internal" },
    }),
    false,
  );
  assert.equal(
    deduplicatedRunMatches(stored, "dm:U1:t1", {
      ...request,
      text: "different body",
    }),
    false,
  );
});

test("an addressed wake retry refuses any envelope change", async () => {
  const { runs } = createMemoryRunStore();
  await runs.enqueue({ sessionId: "dm:U1:t1", request: addressedRequest(), dedupKey: "wake" });
  const stored = await runs.getByDedupKey("wake");
  assert.ok(stored);

  for (const changed of [
    addressedRequest({ at: new Date(1) }),
    addressedRequest({ why: "A different reason." }),
    addressedRequest({ recentMessage: "different context" }),
    addressedRequest({ instructions: "Use different instructions." }),
  ]) {
    assert.equal(deduplicatedRunMatches(stored, "dm:U1:t1", changed), false);
  }
});

test("a retry ignores only client timing metadata", async () => {
  const { runs } = createMemoryRunStore();
  const original = { ...request, clientSentAt: 1, intakePreambleMs: 2 };
  await runs.enqueue({ sessionId: "dm:U1:t1", request: original, dedupKey: "timing" });
  const stored = await runs.getByDedupKey("timing");
  assert.ok(stored);

  assert.equal(
    deduplicatedRunMatches(stored, "dm:U1:t1", {
      ...original,
      clientSentAt: 3,
      intakePreambleMs: 4,
    }),
    true,
  );
});

test("a system ambient wake retry ignores its generated time but not its content", async () => {
  const { runs } = createMemoryRunStore();
  const ambient = (at: Date, why = "The recent messages may warrant a reply."): OrchestratorInput => ({
    ...request,
    actor: { id: "system:ambient:qm", type: "internal" },
    conversation: { kind: "channel", threadRef: "ch:C1:ambient:1.0", channelRef: "C1", audience: [] },
    origin: { kind: "automation" },
    text: buildWakeEnvelope({
      reason: "ambient",
      surface: "slack",
      channel: "C1",
      at,
      why,
      recentMessages: [{ ts: "1.0", authorId: actor.id, text: "status update" }],
      instructions: "Reply if needed.",
    }),
  });
  await runs.enqueue({ sessionId: "ch:C1:ambient:1.0", request: ambient(new Date(0)), dedupKey: "ambient" });
  const stored = await runs.getByDedupKey("ambient");
  assert.ok(stored);

  assert.equal(deduplicatedRunMatches(stored, "ch:C1:ambient:1.0", ambient(new Date(1))), true);
  assert.equal(
    deduplicatedRunMatches(stored, "ch:C1:ambient:1.0", ambient(new Date(1), "Different messages warrant a reply.")),
    false,
  );
});
