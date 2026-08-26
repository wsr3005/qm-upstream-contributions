import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assistantFailure, createOpenCodeHarness, latestAssistantParts } from "../src/harness/opencode-harness.ts";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const realOpenCodeBinary = resolve(import.meta.dirname, "../node_modules/.bin/opencode");

function fakeSidecar(
  dir: string,
  name: string,
  handlers: string,
  startupDelayMs = 0,
  sessionHandler = 'await readBody(req); return json(res, { id: "ses_main" });',
): string {
  const script = join(dir, `${name}.js`);
  writeFileSync(
    script,
    `const http = require("node:http");
const port = Number((process.argv.find((a) => a.startsWith("--port=")) ?? "--port=0").slice("--port=".length));
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); });
const json = (res, value) => { const t = JSON.stringify(value); res.writeHead(200, { "content-type": "application/json" }); res.end(t); };
const capture = async (sessionId, body) =>
  fetch(process.env.OPENCODE_BRIDGE_URL + "/session/" + sessionId + "/capture", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/global/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("\\n"); return; }
  if (req.method === "POST" && url.pathname === "/session") { ${sessionHandler} }
  const message = url.pathname.match(/^\\/session\\/([^/]+)\\/message$/);
  ${handlers}
  return json(res, {});
});
setTimeout(() => server.listen(port, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + port)), ${startupDelayMs});
`,
  );
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const promptHandlers = (assistant: string) => `
  if (req.method === "POST" && message) {
    await readBody(req);
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    return json(res, ${assistant});
  }
  if (req.method === "GET" && message) return json(res, [${assistant}]);
`;

const erroredAssistant = (error: string) => `{
  info: {
    id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000 },
    error: ${error},
    parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
}`;

const errorAssistant = erroredAssistant(
  `{ name: "ProviderAuthError", data: { providerID: "openai", message: "401 Incorrect API key provided" } }`,
);

const okAssistant = `{
  info: {
    id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000, completed: 2929 },
    parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
    cost: 0.0353, tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 50, write: 10 } },
    finish: "stop",
  },
  parts: [{ id: "prt_1", sessionID: "ses_main", messageID: "msg_1", type: "text", text: "hello from fake" }],
}`;

test("OpenCode starts the paid request deadline after a cold custom runtime is ready", async (t) => {
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as { model?: string };
    assert.equal(payload.model, "upstream-luna");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ready", model: "upstream-luna" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { model: "upstream-luna", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamAddress = upstream.address() as AddressInfo;
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-model-test-"));
  const handlers = `
  if (req.method === "POST" && message) {
    await readBody(req);
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    const provider = config.provider.enterprise;
    const response = await fetch(provider.options.baseURL + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + provider.options.apiKey },
      body: JSON.stringify({ model: "upstream-luna", stream: true, max_output_tokens: 128, input: "ping" }),
    });
    await response.text();
    return json(res, ${okAssistant});
  }
  if (req.method === "GET" && message) return json(res, [${okAssistant}]);
`;
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "cold-model-test", handlers, 150) });
  t.after(async () => {
    await harness.turns.close?.();
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(dir, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  const result = await harness.models.testModel!({
    model: "enterprise/luna",
    expectedUpstreamModel: "upstream-luna",
    maxOutputTokens: 128,
    systemPrompt: "test",
    prompt: "ping",
    requestTimeoutMs: 100,
    customProvider: {
      apiKey: "secret",
      spec: {
        id: "enterprise",
        name: "Enterprise",
        protocol: "openai-responses",
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
        models: [{ id: "enterprise/luna", upstreamId: "upstream-luna" }],
      },
    },
  });
  assert.ok(Date.now() - startedAt >= 150);
  assert.equal(result.reply, "hello from fake");
  assert.equal(result.evidence?.upstreamRequests, 1);
  assert.equal(result.evidence?.responseModel, "upstream-luna");
});

test("OpenCode request timeout interrupts a hung session setup after runtime startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-model-timeout-"));
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(
      dir,
      "hung-session-model-test",
      promptHandlers(okAssistant),
      0,
      "await readBody(req); await new Promise(() => {});",
    ),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  await assert.rejects(
    harness.models.testModel!({
      model: "enterprise/luna",
      expectedUpstreamModel: "upstream-luna",
      maxOutputTokens: 128,
      systemPrompt: "test",
      prompt: "ping",
      requestTimeoutMs: 50,
      customProvider: {
        apiKey: "secret",
        spec: {
          id: "enterprise",
          name: "Enterprise",
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          models: [{ id: "enterprise/luna", upstreamId: "upstream-luna" }],
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

test("OpenCode request timeout aborts a hung prompt after session setup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-prompt-timeout-"));
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(
      dir,
      "hung-prompt-model-test",
      'if (req.method === "POST" && message) { await readBody(req); await new Promise(() => {}); }',
    ),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  await assert.rejects(
    harness.models.testModel!({
      model: "enterprise/luna",
      expectedUpstreamModel: "upstream-luna",
      maxOutputTokens: 128,
      systemPrompt: "test",
      prompt: "ping",
      requestTimeoutMs: 50,
      customProvider: {
        apiKey: "secret",
        spec: {
          id: "enterprise",
          name: "Enterprise",
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          models: [{ id: "enterprise/luna", upstreamId: "upstream-luna" }],
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

test("OpenCode returns a stopped turn when user cancellation aborts a prompt request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-user-cancel-"));
  const promptStarted = join(dir, "prompt-started");
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(
      dir,
      "user-cancel",
      `if (req.method === "POST" && message) {
        await readBody(req);
        require("node:fs").writeFileSync(${JSON.stringify(promptStarted)}, message[1]);
        await new Promise(() => {});
      }`,
    ),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const cancel = new AbortController();
  const pending = harness.turns.runTurn({ ...turnInput([], []), cancel: cancel.signal });
  while (!existsSync(promptStarted)) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  cancel.abort();
  assert.deepEqual(await pending, { reply: "", stopped: true });
});

function turnInput(entries: SessionEntry[], llmRows: HarnessLlmRequestRecord[]): HarnessTurnInput {
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const session = { id: "session-1" } as Session;
  return {
    session,
    input: "hi",
    model: "openai/gpt-5",
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
    recordModelCall: () => {},
    recordLlmRequest: async (rec) => {
      llmRows.push(rec);
    },
  };
}

test("OpenCode surfaces a provider error as a non-retryable failure, never a successful empty reply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "provider-error", promptHandlers(errorAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  await assert.rejects(harness.turns.runTurn(turnInput(entries, llmRows)), (error: Error) => {
    assert.equal(error.name, "NonRetryableTurnError");
    assert.match(error.message, /ProviderAuthError/);
    assert.match(error.message, /401 Incorrect API key provided/);
    return true;
  });
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user"],
  );
  assert.equal(llmRows.length, 1);
  assert.equal(llmRows[0]!.step, 0);
});

test("OpenCode fails closed before startup when an explicitly requested model is unavailable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-unavailable-"));
  let resolutions = 0;
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "unavailable", promptHandlers(okAssistant)),
    resolveCustomProviders: async () => {
      resolutions += 1;
      return [];
    },
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const input = turnInput([], []);
  input.model = "removed-custom-model";
  await assert.rejects(harness.turns.runTurn(input), /does not support requested model/);
  assert.equal(resolutions, 0);
});

test("OpenCode records real usage, cost, and timings for each captured model call", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "usage", promptHandlers(okAssistant)) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn(turnInput(entries, llmRows));
  assert.equal(result.reply, "hello from fake");
  assert.equal(result.modelCalls, 1);
  assert.equal(llmRows.length, 1);
  const row = llmRows[0]!;
  assert.equal(row.turnSeq, 1);
  assert.equal(row.step, 0);
  assert.equal(row.model, "openai/gpt-5");
  assert.equal(row.truncated, false);
  assert.deepEqual(row.promptEnvelope, { system: "s" }, "messages stay on the tape, not in the envelope");
  assert.deepEqual(row.transport, { modelId: "openai/gpt-5" });
  assert.equal(row.durationMs, 1929);
  assert.deepEqual(row.usage, {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 183,
    costUsd: 0.0353,
  });
});

test("OpenCode startup failure reports the sidecar's real output and honors the configured timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const noisy = join(dir, "noisy");
  writeFileSync(noisy, `#!/bin/sh\necho "FATAL: missing libfoo" >&2\nexec sleep 30\n`);
  chmodSync(noisy, 0o755);
  const noisyHarness = createOpenCodeHarness({ binaryPath: noisy, startupTimeoutMs: 1500 });
  t.after(async () => noisyHarness.turns.close?.());
  await assert.rejects(noisyHarness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.match(error.message, /did not start within \d+s/);
    assert.match(error.message, /FATAL: missing libfoo/);
    return true;
  });
  const silent = join(dir, "silent");
  writeFileSync(silent, `#!/bin/sh\nexec sleep 30\n`);
  chmodSync(silent, 0o755);
  const silentHarness = createOpenCodeHarness({ binaryPath: silent, startupTimeoutMs: 1500 });
  t.after(async () => silentHarness.turns.close?.());
  await assert.rejects(silentHarness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.match(error.message, /did not start within \d+s: \(no output\)/);
    return true;
  });
});

test("OpenCode keeps the run's retry budget for an APIError the provider marks retryable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const retryableAssistant = erroredAssistant(
    `{ name: "APIError", data: { message: "overloaded", isRetryable: true } }`,
  );
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "retryable", promptHandlers(retryableAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(harness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.equal(error.name, "Error");
    assert.match(error.message, /APIError.*overloaded/);
    return true;
  });
});

test("OpenCode delivers the truncated reply on an output-length error instead of parking the turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const truncatedAssistant = okAssistant.replace(
    'finish: "stop",',
    'error: { name: "MessageOutputLengthError", data: {} },',
  );
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "output-length", promptHandlers(truncatedAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await harness.turns.runTurn(turnInput([], []));
  assert.equal(result.reply, "hello from fake");
});

test("OpenCode treats an aborted assistant message as a quiet stop, not a failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const abortedAssistant = erroredAssistant(`{ name: "MessageAbortedError", data: { message: "aborted" } }`);
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "aborted", promptHandlers(abortedAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await harness.turns.runTurn(turnInput([], []));
  assert.equal(result.reply, "");
});

test("OpenCode records requests without usage attribution when captures and assistant messages misalign", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const doubleCapture = `
  if (req.method === "POST" && message) {
    await readBody(req);
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    await capture(message[1], { system: "s", messages: [{ role: "user" }, { role: "assistant" }] });
    return json(res, ${okAssistant});
  }
  if (req.method === "GET" && message) return json(res, [${okAssistant}]);
`;
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "misaligned", doubleCapture) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn(turnInput([], llmRows));
  assert.equal(result.reply, "hello from fake");
  assert.deepEqual(
    llmRows.map((row) => ({ step: row.step, usage: row.usage, durationMs: row.durationMs })),
    [
      { step: 0, usage: null, durationMs: null },
      { step: 1, usage: null, durationMs: null },
    ],
  );
});

test("latestAssistantParts skips errored and aborted messages, returning the latest successful reply", async () => {
  const stub = (messages: unknown[]) =>
    ({ session: { messages: async () => ({ data: messages }) } }) as unknown as OpencodeClient;
  const errored = {
    info: { role: "assistant", error: { name: "APIError", data: { message: "boom" } } },
    parts: [],
  };
  const aborted = {
    info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    parts: [],
  };
  const ok = { info: { role: "assistant" }, parts: [{ type: "text", text: "fine" }] };
  assert.deepEqual(await latestAssistantParts(stub([ok, errored]), "s"), ok.parts);
  assert.deepEqual(await latestAssistantParts(stub([ok, aborted]), "s"), ok.parts);
  assert.equal(await latestAssistantParts(stub([errored]), "s"), null);
  assert.equal(await latestAssistantParts(stub([]), "s"), null);
});

test("assistantFailure classifies provider errors and exempts aborts and output-length truncation", () => {
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "ProviderAuthError", data: { message: "bad key" } } }),
    { message: "OpenCode provider error (ProviderAuthError): bad key", retryable: false },
  );
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "APIError", data: { message: "529", isRetryable: true } } }),
    { message: "OpenCode provider error (APIError): 529", retryable: true },
  );
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "APIError", data: { message: "400", isRetryable: false } } }),
    { message: "OpenCode provider error (APIError): 400", retryable: false },
  );
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "UnknownError", data: { message: "socket hang up" } } }),
    { message: "OpenCode provider error (UnknownError): socket hang up", retryable: true },
  );
  assert.equal(assistantFailure({ role: "assistant", error: { name: "MessageAbortedError" } }), null);
  assert.equal(assistantFailure({ role: "assistant", error: { name: "MessageOutputLengthError" } }), null);
  assert.equal(assistantFailure({ role: "assistant" }), null);
  assert.equal(assistantFailure(undefined), null);
});

test("custom providers materialize into the opencode config (enabled + provider map, key included)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-custom-"));
  const dump = join(dir, "config.json");
  const bin = fakeSidecar(dir, "custom", promptHandlers(okAssistant));
  // wrap the binary so it writes the config it received before exec
  const wrapped = join(dir, "custom-wrapped");
  writeFileSync(
    wrapped,
    `#!/bin/sh\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(dump)}\nexec ${JSON.stringify(bin)} "$@"\n`,
  );
  chmodSync(wrapped, 0o755);
  const harness = createOpenCodeHarness({
    binaryPath: wrapped,
    resolveCustomProviders: async () => [
      {
        spec: {
          id: "litellm",
          name: "LiteLLM",
          protocol: "openai" as const,
          baseUrl: "http://litellm.internal:4000/v1",
          models: [{ id: "deepseek-chat", name: "DeepSeek", contextWindow: 128000, maxTokens: 8192 }],
        },
        apiKey: "sk-lite",
      },
      {
        spec: {
          id: "responses-gateway",
          name: "Responses Gateway",
          protocol: "openai-responses" as const,
          baseUrl: "http://responses.internal/v1",
          models: [
            {
              id: "responses-gateway/gpt-luna",
              upstreamId: "gpt-5.6-luna",
              inputModalities: ["text", "image"],
            },
          ],
        },
        apiKey: "sk-responses",
      },
    ],
  });
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  try {
    await harness.turns.runTurn(turnInput(entries, llmRows));
    const config = JSON.parse(readFileSync(dump, "utf8"));
    assert.ok(config.enabled_providers.includes("litellm"));
    const litellm = config.provider.litellm;
    assert.equal(litellm.npm, "@ai-sdk/openai-compatible");
    assert.equal(litellm.options.baseURL, "http://litellm.internal:4000/v1");
    assert.equal(litellm.options.apiKey, "sk-lite");
    assert.deepEqual(litellm.models["deepseek-chat"], {
      name: "DeepSeek",
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128000, output: 8192 },
    });
    assert.equal(config.provider["responses-gateway"].npm, "@ai-sdk/openai");
    assert.equal(config.provider["responses-gateway"].options.baseURL, "http://responses.internal/v1");
    assert.deepEqual(config.provider["responses-gateway"].models["gpt-5.6-luna"].limit, {
      context: 128000,
      output: 8192,
    });
    assert.equal(config.provider["responses-gateway"].models["gpt-5.6-luna"].attachment, true);
    assert.deepEqual(config.provider["responses-gateway"].models["gpt-5.6-luna"].modalities.input, ["text", "image"]);
  } finally {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "the installed OpenCode sidecar completes a turn through a saved Responses provider",
  { skip: existsSync(realOpenCodeBinary) ? false : "opencode-ai is not installed" },
  async (t) => {
    const requests: Array<{ path: string; auth?: string; model?: string; maxOutputTokens?: number; image?: boolean }> =
      [];
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const payload = body ? (JSON.parse(body) as { model?: string; max_output_tokens?: number }) : {};
        requests.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          model: payload.model,
          maxOutputTokens: payload.max_output_tokens,
          image: body.includes("iVBORw0KGgo"),
        });
        if (!req.url?.endsWith("/responses")) {
          res.writeHead(404);
          return res.end();
        }
        const item = {
          id: "msg_opencode_qa",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OPENCODE RESPONSES OK", annotations: [] }],
        };
        const response = {
          id: "resp_opencode_qa",
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
            delta: "OPENCODE RESPONSES OK",
          },
          {
            type: "response.output_text.done",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            text: "OPENCODE RESPONSES OK",
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
    await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    setCustomProviders([
      {
        id: "responses-gateway",
        name: "Responses Gateway",
        protocol: "openai-responses",
        baseUrl,
        models: [
          {
            id: "responses-gateway/gpt-luna",
            upstreamId: "gpt-5.6-luna",
            inputModalities: ["text", "image"],
          },
        ],
      },
    ]);
    const harness = createOpenCodeHarness({
      binaryPath: realOpenCodeBinary,
      turnWallClockMs: 60_000,
      resolveCustomProviders: async () => [
        {
          spec: {
            id: "responses-gateway",
            name: "Responses Gateway",
            protocol: "openai-responses",
            baseUrl,
            models: [
              {
                id: "responses-gateway/gpt-luna",
                upstreamId: "gpt-5.6-luna",
                inputModalities: ["text", "image"],
              },
            ],
          },
          apiKey: "sk-opencode-qa",
        },
      ],
    });
    t.after(async () => {
      await harness.turns.close?.();
      upstream.close();
      setCustomProviders([], []);
    });
    const llmRows: HarnessLlmRequestRecord[] = [];
    const modelCalls: Array<{ model: string }> = [];
    const input = turnInput([], llmRows);
    input.session = { id: "real-opencode-responses" } as Session;
    input.model = "responses-gateway/gpt-luna";
    input.readOnly = true;
    input.images = [
      {
        mimeType: "image/png",
        dataBase64: readFileSync(resolve(import.meta.dirname, "live-slack/fixtures/taylor-selfie.png")).toString(
          "base64",
        ),
      },
    ];
    input.recordModelCall = (record) => modelCalls.push(record);
    const result = await harness.turns.runTurn(input);
    assert.equal(result.reply, "OPENCODE RESPONSES OK");
    assert.deepEqual(requests, [
      {
        path: "/v1/responses",
        auth: "Bearer sk-opencode-qa",
        model: "gpt-5.6-luna",
        maxOutputTokens: 8192,
        image: true,
      },
    ]);
    assert.equal(modelCalls[0]?.model, "responses-gateway/gpt-luna");
    assert.equal(llmRows[0]?.model, "responses-gateway/gpt-luna");
    assert.equal(llmRows[0]?.transport?.modelId, "responses-gateway/gpt-5.6-luna");
  },
);
