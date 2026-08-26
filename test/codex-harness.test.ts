import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  codexChildEnv,
  codexCustomRuntimeSpec,
  codexNonRetryable,
  codexProviderFailure,
  codexUsageTotals,
  codexChildToolAllowed,
  codexReasoningEffort,
  codexReplayCallId,
  codexTaskTitle,
  codexTokenUsageUpdate,
  codexToolContext,
  codexTurnInputText,
  createCodexHarness,
  prepareCodexHome,
} from "../src/harness/codex-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";
import { createMemoryTaskStore } from "../src/tasks/memory-task-store.ts";
import { CodexAppServer } from "../src/harness/codex-app-server.ts";
import { DEFAULT_CODEX_MODEL_ID } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const replaySmokeItems = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "earlier question" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
  { type: "function_call", call_id: "call-1", name: "execute", arguments: JSON.stringify({ command: "true" }) },
  { type: "function_call_output", call_id: "call-1", output: "[exit 0]" },
];

test("Codex replay keeps paired tool ids within the provider's 64-character limit", () => {
  const longId = "tool-call-".repeat(9);
  const normalized = codexReplayCallId(longId);
  assert.equal(normalized.length, 64);
  assert.equal(codexReplayCallId(longId), normalized);
  assert.equal(codexReplayCallId("short-id"), "short-id");
});

test("Codex fails closed when an explicitly requested model is unavailable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-unavailable-"));
  let resolutions = 0;
  const harness = createCodexHarness({
    binaryPath: fakeCodexBinary(dir),
    resolveCustomProvider: async () => {
      resolutions += 1;
      return null;
    },
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  await assert.rejects(
    harness.turns.runTurn({
      session: { id: "unavailable" } as Session,
      input: "hi",
      model: "removed-custom-model",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: "unavailable", seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    }),
    /does not support requested model/,
  );
  assert.equal(resolutions, 0);
  assert.equal(existsSync(join(dir, "starts")), false);
});

function fakeCodexBinary(dir: string): string {
  const path = join(dir, "fake-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: { userAgent: "fake" } });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    if (msg.params.sandbox !== "read-only" || msg.params.approvalPolicy !== "never" || !Array.isArray(msg.params.dynamicTools) ||
        !Array.isArray(msg.params.environments) || msg.params.environments.length !== 0 ||
        msg.params.config?.features?.shell_tool !== false || msg.params.config?.features?.unified_exec !== false ||
        process.env.CORE_SIGNING_SECRET || process.env.DATABASE_URL || process.env.HOME !== msg.params.cwd ||
        !process.env.CODEX_HOME?.startsWith(msg.params.cwd)) {
      return send({ id: msg.id, error: { code: -1, message: "unsafe or missing adapter settings" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-1" }, model: "fake-model" } });
  }
  if (msg.method === "thread/inject_items") return send({ id: msg.id, result: {} });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100 }, last: { inputTokens: 100 } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100 }, last: { inputTokens: 100 } } } });
    send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress", senderThreadId: "thread-1", receiverThreadIds: ["child-1"], prompt: "return ALPHA", agentsStates: { "child-1": { status: "running", message: null } } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "child-1", tokenUsage: { total: { inputTokens: 70 }, last: { inputTokens: 70 } } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "completed", senderThreadId: "thread-1", receiverThreadIds: ["child-1"], prompt: "return ALPHA", agentsStates: { "child-1": { status: "completed", message: "ALPHA" } } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 250 }, last: { inputTokens: 150 } } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello", phase: "final_answer", memoryCitation: null } } });
    return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], itemsView: "notLoaded" } } });
  }
  if (msg.method === "turn/interrupt" || msg.method === "turn/steer") return send({ id: msg.id, result: {} });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function customProviderCodexBinary(dir: string): string {
  const path = join(dir, "custom-provider-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    const provider = msg.params.config?.model_providers?.gateway;
    if (msg.params.model !== "gpt-5.6-luna" || msg.params.config?.model_provider !== "gateway" ||
        !String(provider?.base_url).startsWith("http://127.0.0.1:") || provider?.wire_api !== "responses" ||
        provider?.env_key !== "QM_CODEX_PROVIDER_KEY" || process.env.QM_CODEX_PROVIDER_KEY !== "sk-custom" ||
        process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.CODEX_ACCESS_TOKEN ||
        line.includes("sk-custom")) {
      return send({ id: msg.id, error: { code: -1, message: "bad custom provider binding" } });
    }
    return send({ id: msg.id, result: { thread: { id: "thread-custom" }, model: "gpt-5.6-luna" } });
  }
  if (msg.method === "turn/start") {
    if (msg.params.model !== "gpt-5.6-luna") {
      return send({ id: msg.id, error: { code: -1, message: "bad custom turn model" } });
    }
    send({ id: msg.id, result: { turn: { id: "turn-custom", status: "inProgress", items: [] } } });
    return send({ method: "turn/completed", params: { threadId: "thread-custom", turn: { id: "turn-custom", status: "completed", items: [{ type: "agentMessage", text: "CUSTOM-OK", phase: "final_answer" }] } } });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function disconnectingProviderCodexBinary(dir: string): string {
  const path = join(dir, "disconnecting-provider-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let providerBaseUrl;
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    providerBaseUrl = msg.params.config?.model_providers?.gateway?.base_url;
    return send({ id: msg.id, result: { thread: { id: "thread-disconnect" }, model: "gpt-5.6-luna" } });
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-disconnect", status: "inProgress", items: [] } } });
    const response = await fetch(providerBaseUrl + "/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.QM_CODEX_PROVIDER_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, max_output_tokens: 128 }),
    });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    return send({ method: "turn/completed", params: { threadId: "thread-disconnect", turn: { id: "turn-disconnect", status: "failed", error: { message: "provider stream failed" }, items: [] } } });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function hungTurnCodexBinary(dir: string): string {
  const path = join(dir, "hung-turn-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-hung" } } });
  if (msg.method === "turn/start") return;
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function lateTurnCodexBinary(dir: string): string {
  const path = join(dir, "late-turn-codex");
  const started = join(dir, "late-turn-started");
  const interrupted = join(dir, "late-turn-interrupted");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-late" } } });
  if (msg.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(started)}, msg.params.threadId);
    return setTimeout(() => send({ id: msg.id, result: { turn: { id: "turn-late", status: "inProgress", items: [] } } }), 100);
  }
  if (msg.method === "turn/interrupt") {
    fs.writeFileSync(${JSON.stringify(interrupted)}, msg.params.turnId);
    return send({ id: msg.id, result: {} });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function rotatingProviderCodexBinary(dir: string): string {
  const path = join(dir, "rotating-provider-codex");
  const log = join(dir, "runtime-log");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const key = process.env.QM_CODEX_PROVIDER_KEY;
fs.appendFileSync(${JSON.stringify(log)}, "start:" + key + "\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(log)}, "close:" + key + "\\n");
  process.exit(0);
});
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-" + key } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-" + key, status: "inProgress", items: [] } } });
    return send({ method: "turn/completed", params: { threadId: "thread-" + key, turn: { id: "turn-" + key, status: "completed", items: [{ type: "agentMessage", text: key, phase: "final_answer" }] } } });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function terminatingCodexBinary(dir: string): string {
  const path = join(dir, "terminating-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let lateTool;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-stop" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-stop", status: "inProgress", items: [] } } });
    return send({ id: "finish-call", method: "item/tool/call", params: { threadId: "thread-stop", turnId: "turn-stop", callId: "finish-1", tool: "finish_silently", arguments: { reason: "nothing new" } } });
  }
  if (msg.id === "finish-call" && msg.result) {
    lateTool = setTimeout(() => send({ id: "late-call", method: "item/tool/call", params: { threadId: "thread-stop", turnId: "turn-stop", callId: "late-1", tool: "history", arguments: { query: "must not run" } } }), 25);
    return;
  }
  if (msg.id === "late-call" && msg.result) {
    return send({ method: "turn/completed", params: { threadId: "thread-stop", turn: { id: "turn-stop", status: "completed", items: [{ type: "agentMessage", text: "BAD", phase: "final_answer" }] } } });
  }
  if (msg.method === "turn/interrupt") {
    clearTimeout(lateTool);
    send({ id: msg.id, result: {} });
    return send({ method: "turn/completed", params: { threadId: "thread-stop", turn: { id: "turn-stop", status: "interrupted", items: [] } } });
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function concurrentCodexBinary(dir: string): string {
  const path = join(dir, "concurrent-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let starts = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    starts++;
    if (starts === 1) return send({ id: msg.id, result: { thread: { id: "thread-live" } } });
    return;
  }
  if (msg.method === "turn/start" && msg.params.threadId === "thread-live") {
    send({ id: msg.id, result: { turn: { id: "turn-live", status: "inProgress", items: [] } } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-live", turn: { id: "turn-live", status: "completed", items: [{ type: "agentMessage", text: "FIRST-OK", phase: "final_answer" }] } } }), 250);
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function nonresponsiveCodexBinary(dir: string): string {
  const path = join(dir, "nonresponsive-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(join(dir, "starts"))}, "start\\n");
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function delayedCustomCodexBinary(dir: string): string {
  const path = join(dir, "delayed-custom-codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const log = ${JSON.stringify(join(dir, "delayed-log"))};
fs.appendFileSync(log, "start\\n");
fs.writeFileSync(${JSON.stringify(join(dir, "delayed-jail"))}, process.env.HOME);
process.on("SIGTERM", () => { fs.appendFileSync(log, "close\\n"); process.exit(0); });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n"), 300);
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("Codex forwards external-content screening into its native tool bridge", () => {
  const screenExternalContent: NonNullable<HarnessTurnInput["screenExternalContent"]> = async () => ({
    decision: "auto",
  });
  const ref = codexToolContext({ screenExternalContent } as HarnessTurnInput);
  assert.equal(ref.screenExternalContent, screenExternalContent);
});

test("Codex harness drives app-server JSON-RPC with a read-only jail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-test-"));
  const tasks = createMemoryTaskStore();
  const harness = createCodexHarness({ binaryPath: fakeCodexBinary(dir), env: process.env, tasks });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const deltas: string[] = [];
  const modelCalls: number[] = [];
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const session = { id: "session-1" } as Session;
  const result = await harness.turns.runTurn({
    session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => {
      const saved = { ...entry, sessionId: session.id, seq: entries.length + 1, createdAt: Date.now() } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: ({ inputTokens }) => modelCalls.push(inputTokens),
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.reply, "hello");
  assert.deepEqual(deltas, ["hello"]);
  assert.deepEqual(modelCalls, [100, 70, 150]);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user", "tool_call", "tool_result", "assistant"],
  );
  assert.deepEqual(
    (await tasks.list()).map(({ title, status }) => ({ title, status })),
    [{ title: "return ALPHA", status: "completed" }],
  );
});

test("Codex binds a Responses custom provider without exposing its key in RPC", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-custom-"));
  setCustomProviders([
    {
      id: "gateway",
      name: "Gateway",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      models: [{ id: "gateway/gpt-luna", upstreamId: "gpt-5.6-luna" }],
    },
  ]);
  const harness = createCodexHarness({
    binaryPath: customProviderCodexBinary(dir),
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-official",
      OPENAI_BASE_URL: "https://official.example.com/v1",
      CODEX_ACCESS_TOKEN: "official-token",
    },
    resolveCustomProvider: async (modelId) => {
      assert.equal(modelId, "gateway/gpt-luna");
      return {
        id: "gateway",
        name: "Gateway",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "sk-custom",
        modelId: "gpt-5.6-luna",
      };
    },
  });
  t.after(async () => {
    await harness.turns.close?.();
    setCustomProviders([], []);
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const session = { id: "session-custom" } as Session;
  const modelCalls: Array<{ model: string }> = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn({
    session,
    input: "hi",
    model: "gateway/gpt-luna",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => ({ ...entry, sessionId: session.id, seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: (record) => modelCalls.push(record),
    recordLlmRequest: async (record) => {
      llmRows.push(record);
    },
  });
  assert.equal(result.reply, "CUSTOM-OK");
  assert.equal(modelCalls[0]?.model, "gateway/gpt-luna");
  assert.equal(llmRows[0]?.model, "gateway/gpt-luna");
  assert.equal(llmRows[0]?.transport?.modelId, "gpt-5.6-luna");
});

test("Codex request timeout interrupts a hung turn start after runtime startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-model-timeout-"));
  const harness = createCodexHarness({ binaryPath: hungTurnCodexBinary(dir), env: process.env });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  await assert.rejects(
    harness.models.testModel!({
      model: "gateway/gpt-luna",
      expectedUpstreamModel: "gpt-5.6-luna",
      maxOutputTokens: 128,
      systemPrompt: "test",
      prompt: "ping",
      requestTimeoutMs: 50,
      customProvider: {
        apiKey: "secret",
        spec: {
          id: "gateway",
          name: "Gateway",
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          models: [{ id: "gateway/gpt-luna", upstreamId: "gpt-5.6-luna" }],
        },
      },
    }),
    (error: Error & { category?: string; attempt?: { upstreamRequests?: number } }) => {
      assert.equal(error.name, "HarnessModelTestError");
      assert.equal(error.category, "request_timeout");
      assert.equal(error.attempt?.upstreamRequests, 0);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("Codex model testing preserves paid evidence after the app-server rejects a stream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-model-disconnect-"));
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "works", response: { model: "gpt-5.6-luna" } })}\n\n`,
      );
      setTimeout(
        () =>
          res.end(
            `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-5.6-luna", usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } } })}\n\n`,
          ),
        25,
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const harness = createCodexHarness({ binaryPath: disconnectingProviderCodexBinary(dir), env: process.env });
  t.after(async () => {
    await harness.turns.close?.();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    harness.models.testModel!({
      model: "gateway/gpt-luna",
      expectedUpstreamModel: "gpt-5.6-luna",
      maxOutputTokens: 128,
      systemPrompt: "test",
      prompt: "ping",
      requestTimeoutMs: 1_000,
      customProvider: {
        apiKey: "sk-disconnect",
        spec: {
          id: "gateway",
          name: "Gateway",
          protocol: "openai-responses",
          baseUrl,
          models: [{ id: "gateway/gpt-luna", upstreamId: "gpt-5.6-luna" }],
        },
      },
    }),
    (error: Error & { category?: string; attempt?: Record<string, unknown> }) => {
      assert.equal(error.name, "HarnessModelTestError");
      assert.equal(error.category, "response_verification_failed");
      assert.deepEqual(
        {
          upstreamRequests: error.attempt?.upstreamRequests,
          responseCompleted: error.attempt?.responseCompleted,
          clientDisconnected: error.attempt?.clientDisconnected,
          terminalEventObserved: error.attempt?.terminalEventObserved,
          usageObserved: error.attempt?.usageObserved,
          observedEventTypes: error.attempt?.observedEventTypes,
        },
        {
          upstreamRequests: 1,
          responseCompleted: true,
          clientDisconnected: true,
          terminalEventObserved: true,
          usageObserved: true,
          observedEventTypes: ["response.output_text.delta", "response.completed"],
        },
      );
      assert.deepEqual((error.attempt?.evidence as { usage?: unknown })?.usage, {
        inputTokens: 11,
        outputTokens: 2,
        totalTokens: 13,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      return true;
    },
  );
});

test("Codex interrupts a late turn start after returning from user cancellation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-late-turn-"));
  const harness = createCodexHarness({ binaryPath: lateTurnCodexBinary(dir), env: process.env });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const cancel = new AbortController();
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const pending = harness.turns.runTurn({
    session: { id: "late-turn" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    cancel: cancel.signal,
    emit: async (entry) => ({ ...entry, sessionId: "late-turn", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });
  while (!existsSync(join(dir, "late-turn-started"))) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  cancel.abort();
  assert.deepEqual(await pending, { reply: "", stopped: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  assert.equal(readFileSync(join(dir, "late-turn-interrupted"), "utf8"), "turn-late");
});

test("custom Codex runtime identity rotates with endpoint or key and strips built-in credentials", () => {
  const source = {
    OPENAI_API_KEY: "official-key",
    OPENAI_BASE_URL: "https://official.example.com/v1",
    CODEX_ACCESS_TOKEN: "official-token",
    PATH: "/bin",
    NO_PROXY: "corp.internal",
    no_proxy: "service.local",
  };
  const first = codexCustomRuntimeSpec(source, {
    id: "gateway",
    name: "Gateway",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "sk-one",
  });
  const second = codexCustomRuntimeSpec(source, {
    id: "gateway",
    name: "Gateway",
    baseUrl: "https://gateway.example.com/v2",
    apiKey: "sk-two",
  });
  assert.notEqual(first.key, second.key);
  assert.equal(first.env.QM_CODEX_PROVIDER_KEY, "sk-one");
  assert.equal(first.env.OPENAI_API_KEY, undefined);
  assert.equal(first.env.OPENAI_BASE_URL, undefined);
  assert.equal(first.env.CODEX_ACCESS_TOKEN, undefined);
  assert.match(first.env.NO_PROXY!, /(?:^|,)127\.0\.0\.1(?:,|$)/);
  assert.match(first.env.no_proxy!, /(?:^|,)localhost(?:,|$)/);
  assert.match(first.env.NO_PROXY!, /(?:^|,)corp\.internal(?:,|$)/);
  assert.match(first.env.no_proxy!, /(?:^|,)service\.local(?:,|$)/);
  assert.equal(first.env.PATH, "/bin");
  assert.equal(JSON.stringify(first.config).includes("sk-one"), false);
  assert.equal(first.key.includes("sk-one"), false);
  const singleAttempt = codexCustomRuntimeSpec(
    source,
    {
      id: "gateway",
      name: "Gateway",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-one",
    },
    true,
  );
  assert.deepEqual((singleAttempt.config.model_providers as Record<string, Record<string, unknown>>).gateway, {
    name: "Gateway",
    base_url: "https://gateway.example.com/v1",
    env_key: "QM_CODEX_PROVIDER_KEY",
    wire_api: "responses",
    request_max_retries: 0,
    stream_max_retries: 0,
  });
});

test("Codex retires an idle provider process when its saved key rotates", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-rotate-"));
  let key = "sk-one";
  setCustomProviders([
    {
      id: "gateway",
      name: "Gateway",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      models: [{ id: "responses-model" }],
    },
  ]);
  const harness = createCodexHarness({
    binaryPath: rotatingProviderCodexBinary(dir),
    env: { PATH: process.env.PATH },
    resolveCustomProvider: async () => ({
      id: "gateway",
      name: "Gateway",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: key,
    }),
  });
  t.after(async () => {
    await harness.turns.close?.();
    setCustomProviders([], []);
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const run = (id: string) =>
    harness.turns.runTurn({
      session: { id } as Session,
      input: "hi",
      model: "responses-model",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    });
  assert.equal((await run("rotation-one")).reply, "sk-one");
  key = "sk-two";
  assert.equal((await run("rotation-two")).reply, "sk-two");
  assert.equal(
    readFileSync(join(dir, "runtime-log"), "utf8"),
    "start:sk-one\nclose:sk-one\nstart:sk-two\nclose:sk-two\n",
  );
});

test("Codex task titles stay concise when the provider includes the parent request", () => {
  assert.equal(
    codexTaskTitle("The user asked for two workers. You are the WEST subagent. Return a useful summary."),
    "WEST subagent",
  );
  assert.equal(codexTaskTitle("Return ALPHA"), "Return ALPHA");
});

test("Codex maps the web effort control to native reasoning effort", () => {
  assert.equal(codexReasoningEffort("low"), "low");
  assert.equal(codexReasoningEffort("xhigh"), "xhigh");
  assert.equal(codexReasoningEffort("off"), undefined);
});

test("Codex reads cumulative app-server token usage without double-counting updates", () => {
  const first = codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 120 }, last: { inputTokens: 120 } } });
  assert.deepEqual(first, { inputTokens: 120, totalInputTokens: 120 });
  assert.equal(
    codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 120 }, last: { inputTokens: 120 } } }, 120),
    null,
  );
  assert.deepEqual(
    codexTokenUsageUpdate({ tokenUsage: { total: { inputTokens: 275 }, last: { inputTokens: 155 } } }, 120),
    { inputTokens: 155, totalInputTokens: 275 },
  );
});

test("Codex seeds prior surface turns when the durable log is empty", () => {
  const text = codexTurnInputText({
    history: [],
    priorTurns: [
      { role: "user", text: "Earlier question", name: "Alice" },
      { role: "assistant", text: "Earlier answer" },
    ],
    input: "Current question",
    environment: "Current environment",
  });
  assert.match(text, /<message from="human" author="Alice">Earlier question<\/message>/);
  assert.match(text, /<message from="agent">Earlier answer<\/message>/);
  assert.match(text, /Current question\n\nCurrent environment$/);
  assert.equal(
    codexTurnInputText({
      history: [{ type: "user" } as SessionEntry],
      priorTurns: [{ role: "user", text: "duplicate" }],
      input: "current",
    }),
    "current",
  );
});

test("Codex child environment excludes core credentials and user homes", () => {
  const env = codexChildEnv(
    {
      PATH: "/bin",
      HOME: "/Users/private",
      CODEX_HOME: "/Users/private/.codex",
      CORE_SIGNING_SECRET: "signing-secret",
      DATABASE_URL: "postgres://secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-needed-by-provider",
      CODEX_ACCESS_TOKEN: "codex-access-token",
    },
    "/tmp/control-jail",
  );

  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/tmp/control-jail",
    CODEX_HOME: "/tmp/control-jail/codex-home",
    OPENAI_API_KEY: "openai-needed-by-provider",
    CODEX_ACCESS_TOKEN: "codex-access-token",
  });
});

test("Codex materializes API-key auth into its isolated home, and never an ambient login", (t) => {
  const jail = mkdtempSync(join(tmpdir(), "qm-codex-auth-test-"));
  t.after(() => rmSync(jail, { recursive: true, force: true }));
  const home = prepareCodexHome({ OPENAI_API_KEY: "sk-test" }, jail);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-test",
  });

  const bare = mkdtempSync(join(tmpdir(), "qm-codex-auth-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(existsSync(join(prepareCodexHome({ HOME: homedir() }, bare), "auth.json")), false);
});

test("Codex children cannot use parent surface, control, or terminal tools", () => {
  assert.equal(codexChildToolAllowed("history"), true);
  assert.equal(codexChildToolAllowed("execute"), true);
  for (const denied of ["slack", "cron", "webhook", "guidance", "share", "stay_silent", "finish_silently"]) {
    assert.equal(codexChildToolAllowed(denied), false, denied);
  }
});

test("Codex interrupts the provider after a terminal QM tool", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-stop-test-"));
  const harness = createCodexHarness({
    binaryPath: terminatingCodexBinary(dir),
    env: process.env,
    turnWallClockMs: 2_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const result = await harness.turns.runTurn({
    session: { id: "terminal-tool" } as Session,
    input: "poll",
    systemPrompt: "finish silently",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    pollFire: true,
    emit: async (entry) => {
      const saved = {
        ...entry,
        sessionId: "terminal-tool",
        seq: entries.length + 1,
        createdAt: Date.now(),
      } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: () => {},
  });

  assert.equal(result.silent, true);
  assert.notEqual(result.reply, "BAD");
  assert.equal(
    entries.some((entry) => entry.type === "assistant"),
    false,
  );
});

test("Codex spawn failure does not hang run or cleanup", async () => {
  const harness = createCodexHarness({ binaryPath: "/definitely/missing/qm-codex" });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = harness.turns.runTurn({
    session: { id: "missing-binary" } as Session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => ({ ...entry, sessionId: "missing-binary", seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });
  await assert.rejects(
    Promise.race([turn, new Promise((_, reject) => setTimeout(() => reject(new Error("run hung")), 2_000))]),
    /ENOENT|spawn/,
  );
  await Promise.race([
    harness.turns.close?.(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 2_000)),
  ]);
});

test("Codex discards a nonresponsive startup so a later turn can retry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-startup-test-"));
  const harness = createCodexHarness({
    binaryPath: nonresponsiveCodexBinary(dir),
    env: process.env,
    appServerStartTimeoutMs: 1_000,
    turnWallClockMs: 6_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const turn = (id: string) =>
    harness.turns.runTurn({
      session: { id } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    });

  await assert.rejects(turn("first"), /initialization timed out/);
  await assert.rejects(turn("second"), /initialization timed out/);
  assert.equal(readFileSync(join(dir, "starts"), "utf8"), "start\nstart\n");
});

test("a timed-out custom Codex startup closes after its background initialization finishes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-abandoned-custom-"));
  setCustomProviders([
    {
      id: "gateway",
      name: "Gateway",
      protocol: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      models: [{ id: "responses-model" }],
    },
  ]);
  const harness = createCodexHarness({
    binaryPath: delayedCustomCodexBinary(dir),
    env: { PATH: process.env.PATH },
    turnWallClockMs: 50,
    appServerStartTimeoutMs: 2_000,
    resolveCustomProvider: async () => ({
      id: "gateway",
      name: "Gateway",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-abandoned",
    }),
  });
  t.after(async () => {
    await harness.turns.close?.();
    setCustomProviders([], []);
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  await assert.rejects(
    harness.turns.runTurn({
      session: { id: "abandoned-custom" } as Session,
      input: "hi",
      model: "responses-model",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) =>
        ({ ...entry, sessionId: "abandoned-custom", seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    }),
    /exceeded/,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
  assert.equal(readFileSync(join(dir, "delayed-log"), "utf8"), "start\nclose\n");
  assert.equal(existsSync(readFileSync(join(dir, "delayed-jail"), "utf8")), false);
});

test("cancelling one Codex setup does not kill another active turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-concurrent-test-"));
  const harness = createCodexHarness({
    binaryPath: concurrentCodexBinary(dir),
    env: process.env,
    turnWallClockMs: 2_000,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const makeTurn = (id: string, cancel?: AbortSignal): HarnessTurnInput => ({
    session: { id } as Session,
    input: id,
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    ...(cancel ? { cancel } : {}),
    emit: async (entry) => ({ ...entry, sessionId: id, seq: 1, createdAt: Date.now() }) as SessionEntry,
    recordModelCall: () => {},
  });

  const first = harness.turns.runTurn(makeTurn("first"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const controller = new AbortController();
  const second = harness.turns.runTurn(makeTurn("second", controller.signal));
  setTimeout(() => controller.abort(), 50);

  assert.deepEqual(await second, { reply: "", stopped: true });
  assert.equal((await first).reply, "FIRST-OK");
});

test("Codex classifies deterministic provider failures as terminal and leaves transient ones retryable", () => {
  const terminal = [
    "Codex 401: Incorrect API key provided",
    "Codex app-server exited (1): stream error: unauthorized",
    "You exceeded your current quota, please check your plan and billing details",
    "The model `gpt-5.6-sol` does not exist or you do not have access to it",
    "Not logged in. Run `codex login` to authenticate.",
    "Codex -32000: invalid_api_key",
    "403 Forbidden",
    "HTTP 402 Payment Required",
    "Your organization must be verified to stream this model",
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    "You've reached your workspace credit limit",
    "Your workspace is out of credits. Ask your workspace owner to add more.",
    "workspace_owner_credits_depleted",
  ];
  for (const message of terminal) {
    assert.equal(codexNonRetryable(message), true, message);
    assert.ok(codexProviderFailure(message) instanceof NonRetryableTurnError, message);
  }

  const transient = [
    "Rate limit reached for gpt-5.6-sol, please retry",
    "429 Too Many Requests",
    "The server had an error while processing your request",
    "socket hang up",
    "Codex app-server exited (null): ECONNRESET",
    "Codex turn failed",
    "rate_limit_reached",
    "You've hit your usage limit for gpt-5.6-sol",
    "workspace_member_usage_limit_reached",
    "407 Proxy Authentication Required",
  ];
  for (const message of transient) {
    assert.equal(codexNonRetryable(message), false, message);
    assert.ok(!(codexProviderFailure(message) instanceof NonRetryableTurnError), message);
  }
});

test("Codex never classifies its own infrastructure failures as terminal", () => {
  const ours = [
    "permission denied for table session_entries",
    "EACCES: permission denied, open '/data/tape/x.jsonl'",
    "Codex app-server exited (1): thread panicked at src/client.rs:403:9",
    "Codex app-server exited (1): WARN retrying request: 401 Unauthorized (attempt 1); INFO recovered",
    "connect ECONNREFUSED 127.0.0.1:403",
  ];
  for (const message of ours) {
    assert.ok(codexProviderFailure(message) instanceof Error, message);
  }
  assert.equal(codexProviderFailure("Codex turn failed").message, "Codex turn failed");
  assert.ok(!(codexProviderFailure("socket hang up") instanceof NonRetryableTurnError));
});

test("Codex reads cumulative usage totals off the app-server's token notification", () => {
  assert.deepEqual(
    codexUsageTotals({
      tokenUsage: { total: { inputTokens: 400, outputTokens: 90, cachedInputTokens: 120 }, last: { inputTokens: 40 } },
    }),
    { input: 400, output: 90, cacheRead: 120, cacheWrite: 0, totalTokens: 490, costUsd: 0 },
  );
  assert.equal(codexUsageTotals({ tokenUsage: { last: { inputTokens: 40 } } }), null);
  assert.equal(codexUsageTotals(null), null);
});

function failingProviderCodexBinary(dir: string, mode: "turnFailed" | "startRejected"): string {
  const path = join(dir, `failing-codex-${mode}`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") return send({ id: msg.id, result: { thread: { id: "thread-fail" } } });
  if (msg.method === "turn/start") {
    ${
      mode === "startRejected"
        ? `return send({ id: msg.id, error: { code: 401, message: "Incorrect API key provided" } });`
        : `send({ id: msg.id, result: { turn: { id: "turn-fail", status: "inProgress", items: [] } } });
    return send({ method: "turn/completed", params: { threadId: "thread-fail", turn: { id: "turn-fail", status: "failed", error: { message: "You exceeded your current quota" }, items: [] } } });`
    }
  }
  if (msg.method === "turn/interrupt") return send({ id: msg.id, result: {} });
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

for (const mode of ["turnFailed", "startRejected"] as const) {
  test(`Codex parks the run on a provider auth/quota failure (${mode}) instead of burning retries`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-codex-fail-test-"));
    const harness = createCodexHarness({
      binaryPath: failingProviderCodexBinary(dir, mode),
      env: process.env,
      turnWallClockMs: 5_000,
    });
    t.after(async () => {
      await harness.turns.close?.();
      rmSync(dir, { recursive: true, force: true });
    });
    const scope = { kind: "org", id: "test" } as unknown as ScopeId;
    await assert.rejects(
      harness.turns.runTurn({
        session: { id: "fail-session" } as Session,
        input: "hi",
        systemPrompt: "be concise",
        history: [],
        tools: {} as HarnessTurnInput["tools"],
        scopeLabel: scope,
        orgScopeId: scope,
        emit: async (entry) => ({ ...entry, sessionId: "fail-session", seq: 1, createdAt: Date.now() }) as SessionEntry,
        recordModelCall: () => {},
      }),
      (error: unknown) => error instanceof NonRetryableTurnError,
    );
  });
}

test("Codex records one llm row per turn carrying real timings and usage, even when the turn fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-telemetry-test-"));
  const records: HarnessLlmRequestRecord[] = [];
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const runWith = async (binaryPath: string, id: string) => {
    const harness = createCodexHarness({ binaryPath, env: process.env, turnWallClockMs: 5_000 });
    t.after(async () => await harness.turns.close?.());
    return await harness.turns.runTurn({
      session: { id } as Session,
      input: "hi",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => ({ ...entry, sessionId: id, seq: 4, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
      recordLlmRequest: (rec) => void records.push(rec),
    });
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runWith(fakeCodexBinary(dir), "telemetry-ok");
  assert.equal(records.length, 1);
  const ok = records[0]!;
  assert.equal(ok.turnSeq, 4);
  assert.equal(ok.step, 0);
  assert.equal(ok.truncated, false);
  assert.ok(typeof ok.durationMs === "number" && ok.durationMs >= 0);
  assert.ok(typeof ok.ttftMs === "number" && ok.ttftMs >= 0);
  assert.deepEqual(ok.usage, { input: 320, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 320, costUsd: 0 });

  await assert.rejects(runWith(failingProviderCodexBinary(dir, "turnFailed"), "telemetry-fail"));
  assert.equal(records.length, 2);
  assert.ok(typeof records[1]!.durationMs === "number");
});

const realCodexBinary = (() => {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")), "bin/codex.js");
  } catch {
    return null;
  }
})();

test(
  "the installed Codex app-server accepts the exact thread/start this adapter sends",
  { skip: realCodexBinary && existsSync(realCodexBinary) ? false : "@openai/codex is not resolvable" },
  async (t) => {
    const jail = mkdtempSync(join(tmpdir(), "qm-codex-real-"));
    prepareCodexHome({ CODEX_HOME: join(jail, "empty-source") }, jail);
    const requests: string[] = [];
    const server = new CodexAppServer({
      binaryPath: realCodexBinary!,
      cwd: jail,
      env: codexChildEnv({ PATH: process.env.PATH, QM_CODEX_PROVIDER_KEY: "sk-fake" }, jail),
      onNotification: () => {},
      onRequest: async (method) => {
        requests.push(method);
        throw new Error("unexpected request");
      },
    });
    t.after(async () => {
      await server.close();
      rmSync(jail, { recursive: true, force: true });
    });

    await server.initialize();
    const started = await server.request<{ thread: { id: string } }>("thread/start", {
      model: DEFAULT_CODEX_MODEL_ID,
      cwd: jail,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "be concise",
      developerInstructions: "use the supplied dynamic tools",
      dynamicTools: [
        {
          type: "function",
          name: "execute",
          description: "run a command",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      experimentalRawEvents: true,
      environments: [],
      config: {
        web_search: "disabled",
        features: {
          shell_tool: false,
          unified_exec: false,
          shell_snapshot: false,
          apps: false,
          plugins: false,
          browser_use: false,
          browser_use_external: false,
          computer_use: false,
          image_generation: false,
          in_app_browser: false,
          multi_agent: true,
          request_permissions_tool: false,
          tool_suggest: false,
        },
      },
    });
    assert.ok(started.thread.id, "the real app-server returned a thread id for our start shape");
    await server.request("thread/inject_items", {
      threadId: started.thread.id,
      items: replaySmokeItems,
    });
    const custom = await server.request<{ thread: { id: string } }>("thread/start", {
      model: "responses-model",
      cwd: jail,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      dynamicTools: [],
      environments: [],
      config: {
        model_provider: "gateway",
        model_providers: {
          gateway: {
            name: "Gateway",
            base_url: "https://gateway.example.com/v1",
            env_key: "QM_CODEX_PROVIDER_KEY",
            wire_api: "responses",
          },
        },
        web_search: "disabled",
      },
    });
    assert.ok(custom.thread.id);
    assert.deepEqual(requests, []);
  },
);

test(
  "the installed Codex app-server completes a turn through a saved Responses provider binding",
  { skip: realCodexBinary && existsSync(realCodexBinary) ? false : "@openai/codex is not resolvable" },
  async (t) => {
    const requests: Array<{ path: string; auth?: string; model?: string; responsesLite?: string }> = [];
    let proxyRequests = 0;
    const hostileProxy = createServer((req, res) => {
      proxyRequests += 1;
      req.resume();
      res.writeHead(502);
      res.end();
    });
    await new Promise<void>((resolve) => hostileProxy.listen(0, "127.0.0.1", resolve));
    const hostileProxyUrl = `http://127.0.0.1:${(hostileProxy.address() as AddressInfo).port}`;
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const payload = body ? (JSON.parse(body) as { model?: string }) : {};
        requests.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          model: payload.model,
          responsesLite: req.headers["x-openai-internal-codex-responses-lite"] as string | undefined,
        });
        if (!req.url?.endsWith("/responses")) {
          res.writeHead(404);
          return res.end();
        }
        const item = {
          id: "msg_codex_qa",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "CODEX RESPONSES OK", annotations: [] }],
        };
        const response = {
          id: "resp_codex_qa",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: "gpt-5.6-luna",
          output: [item],
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 9,
          },
        };
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: "CODEX RESPONSES OK",
          },
          {
            type: "response.output_text.done",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            text: "CODEX RESPONSES OK",
          },
          {
            type: "response.content_part.done",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            part: item.content[0],
          },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        events.forEach((event, sequence_number) =>
          res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`),
        );
        res.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    setCustomProviders([
      {
        id: "gateway",
        name: "Gateway",
        protocol: "openai-responses",
        baseUrl,
        models: [{ id: "gateway/gpt-luna", upstreamId: "gpt-5.6-luna" }],
      },
    ]);
    const harness = createCodexHarness({
      binaryPath: realCodexBinary!,
      env: {
        PATH: process.env.PATH,
        HTTP_PROXY: hostileProxyUrl,
        HTTPS_PROXY: hostileProxyUrl,
        ALL_PROXY: hostileProxyUrl,
        NO_PROXY: "",
      },
      turnWallClockMs: 10_000,
      resolveCustomProvider: async (modelId) => ({
        id: "gateway",
        name: "Gateway",
        baseUrl,
        apiKey: "sk-codex-qa",
        modelId: modelId === "gateway/gpt-luna" ? "gpt-5.6-luna" : modelId,
      }),
    });
    t.after(async () => {
      await harness.turns.close?.();
      hostileProxy.close();
      upstream.close();
      setCustomProviders([], []);
    });
    const scope = { kind: "org", id: "test" } as unknown as ScopeId;
    const result = await harness.turns.runTurn({
      session: { id: "real-custom-provider" } as Session,
      input: "reply briefly",
      model: "gateway/gpt-luna",
      systemPrompt: "be concise",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      readOnly: true,
      emit: async (entry) =>
        ({ ...entry, sessionId: "real-custom-provider", seq: 1, createdAt: Date.now() }) as SessionEntry,
      recordModelCall: () => {},
    });
    assert.equal(result.reply, "CODEX RESPONSES OK");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.path, "/v1/responses");
    assert.equal(requests[0]?.auth, "Bearer sk-codex-qa");
    assert.equal(requests[0]?.model, "gpt-5.6-luna");
    assert.equal(requests[0]?.responsesLite, undefined);
    assert.equal(proxyRequests, 0);
  },
);
