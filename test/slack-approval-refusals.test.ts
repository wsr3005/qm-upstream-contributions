import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovals } from "../src/slack/approvals.ts";
import { createThreadTracker } from "../src/slack/lib.ts";
import type { TurnResult } from "../src/types.ts";

function slackClient() {
  const updates: Array<{ channel: string; ts: string; text: string }> = [];
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    conversations: { open: async () => ({ channel: { id: "D2" } }) },
    chat: {
      postEphemeral: async () => ({}),
      postMessage: async (message: Record<string, unknown>) => {
        posts.push(message);
        return { ts: String(posts.length) };
      },
      update: async (message: { channel: string; ts: string; text: string }) => {
        updates.push(message);
        return {};
      },
    },
  };
  return { client, posts, updates };
}

function actionHandlers(approvals: ReturnType<typeof createApprovals>) {
  const handlers: Array<{ pattern: RegExp; handler: (args: any) => Promise<void> }> = [];
  approvals.registerActions({ action: (pattern, handler) => handlers.push({ pattern, handler }) });
  return {
    approval: handlers.find(({ pattern }) => pattern.test("hilo_allow_once"))!.handler,
    agentRequest: handlers.find(({ pattern }) => pattern.test("agent_request_run"))!.handler,
  };
}

async function runAgentHandoff(result: TurnResult): Promise<string> {
  const { client, posts, updates } = slackClient();
  const approvals = createApprovals({
    core: {} as any,
    bridge: {
      callCore: async () => result,
      fetchBlobFromCore: async () => new Uint8Array(),
      fetchFileArtifactFromCore: async () => new Uint8Array(),
      reportRunEditRef: () => {},
    } as any,
    directory: {
      classifyUserCached: async () => ({ actor: { externalId: "U2", displayName: "Pat" } }),
    } as any,
    threads: createThreadTracker(),
    ids: {} as any,
  });

  await approvals.postAgentRequests(
    client,
    {
      requesterId: "U1",
      channel: "C1",
      threadOnly: true,
      kind: "channel",
      audience: [{ externalId: "U2", displayName: "Pat" }],
    },
    [{ targetUserId: "U2", task: "Run a private check" }],
  );
  const dm = posts.find((message) => message.channel === "D2") as any;
  const run = dm.blocks
    .find((block: any) => block.type === "actions")
    .elements.find((element: any) => element.action_id === "agent_request_run");
  await actionHandlers(approvals).agentRequest({
    ack: async () => {},
    body: { user: { id: "U2" }, channel: { id: "D2" }, message: { ts: "2" } },
    action: run,
    client,
  });

  return updates.map(({ text }) => text).join("\n");
}

test("agent handoff redacts a security quarantine refusal", async () => {
  const internalReason = "secret quarantine evidence";
  const surfaced = await runAgentHandoff({
    status: "refused",
    refusalKind: "security_quarantine",
    reason: internalReason,
  });
  assert.doesNotMatch(surfaced, new RegExp(internalReason));
  assert.match(surfaced, /security quarantine/);
});

test("agent handoff preserves a reasonless failure status", async () => {
  const surfaced = await runAgentHandoff({ status: "failed" });
  assert.match(surfaced, /failed/);
  assert.doesNotMatch(surfaced, /refused/);
});

test("approval continuation redacts quarantine detail and admin URL", async () => {
  const { client, updates } = slackClient();
  const internalReason = "secret quarantine evidence";
  const adminUrl = "https://internal.invalid/run/123";
  const approvals = createApprovals({
    core: {} as any,
    bridge: {
      callCore: async () => ({
        status: "refused",
        refusalKind: "security_quarantine",
        reason: internalReason,
        adminUrl,
      }),
      fetchBlobFromCore: async () => new Uint8Array(),
      fetchFileArtifactFromCore: async () => new Uint8Array(),
      reportRunEditRef: () => {},
    } as any,
    directory: { classifyActor: async () => ({ externalId: "U1" }) } as any,
    threads: createThreadTracker(),
    ids: {} as any,
  });
  approvals.rememberSlackApprovals([{ requestId: "req-1", command: "run task", reason: "requires approval" }], {
    requesterId: "U1",
    channel: "C1",
    approvalChannel: "C1",
    threadOnly: false,
    turn: {
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1" },
      text: "run task",
    },
  } as any);
  await actionHandlers(approvals).approval({
    ack: async () => {},
    body: { user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "1" } },
    action: { action_id: "hilo_allow_once", value: "req-1" },
    client,
  });

  const surfaced = updates.map(({ text }) => text).join("\n");
  assert.doesNotMatch(surfaced, new RegExp(internalReason));
  assert.doesNotMatch(surfaced, new RegExp(adminUrl));
  assert.match(updates.at(-1)!.text, /I can't continue — security quarantine\./);
});
