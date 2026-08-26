import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { createModelTestProxy, type ModelTestProxyEvidence } from "../src/harness/model-test-proxy.ts";
import { modelTestError } from "../src/harness/harness.ts";

test("model test failures distinguish upstream rejection from response verification", () => {
  const signal = new AbortController().signal;
  assert.equal(
    modelTestError(signal, { upstreamRequests: 1, upstreamStatus: 401, responseCompleted: true }).category,
    "provider_request_failed",
  );
  assert.equal(
    modelTestError(signal, { upstreamRequests: 1, upstreamStatus: 200, responseCompleted: true }).category,
    "response_verification_failed",
  );
});

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

async function upstream(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function streamEvidence(events: Record<string, unknown>[]): Promise<ModelTestProxyEvidence> {
  const server = await upstream(async (req, res) => {
    await body(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  const proxy = await createModelTestProxy(server.baseUrl, {
    expectedModel: "gpt-5.6-luna",
    maxOutputTokens: 128,
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, max_tokens: 128 }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    return proxy.evidence();
  } finally {
    await proxy.close();
    await server.close();
  }
}

test("model test proxy caps and verifies one streaming Chat Completions request", async () => {
  const calls: Record<string, unknown>[] = [];
  const server = await upstream(async (req, res) => {
    calls.push(await body(req));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ model: "gpt-5.6-luna", choices: [{ delta: { content: "works" } }] })}\n\n`);
    res.end(
      `data: ${JSON.stringify({ model: "gpt-5.6-luna", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  const proxy = await createModelTestProxy(`${server.baseUrl}/v1`, {
    expectedModel: "gpt-5.6-luna",
    maxOutputTokens: 128,
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        stream: true,
        max_tokens: 500,
        tools: [{ type: "function" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /works/);
    assert.deepEqual(proxy.evidence().usage, {
      inputTokens: 11,
      outputTokens: 2,
      totalTokens: 13,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    assert.equal(proxy.evidence().responseModel, "gpt-5.6-luna");
    assert.equal(proxy.evidence().streamed, true);
    assert.equal(proxy.evidence().upstreamRequests, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.max_tokens, 128);
    assert.deepEqual(calls[0]?.stream_options, { include_usage: true });
    assert.equal("tools" in calls[0]!, false);

    const duplicate = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    });
    assert.equal(duplicate.status, 400);
    assert.equal(calls.length, 1);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("model test proxy rejects unverifiable response models without a retry", async () => {
  let calls = 0;
  let received: Record<string, unknown> = {};
  const server = await upstream(async (req, res) => {
    calls += 1;
    received = await body(req);
    const response = JSON.stringify({
      id: "response-1",
      model: "gpt-5.6-sol",
      output: [],
      usage: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(response);
  });
  const proxy = await createModelTestProxy(server.baseUrl, {
    expectedModel: "gpt-5.6-luna",
    maxOutputTokens: 128,
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", max_output_tokens: 500 }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.throws(() => proxy.evidence(), /did not match/);
    assert.equal(calls, 1);
    assert.equal(received.max_output_tokens, 128);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("model test proxy merges Anthropic streaming usage", async () => {
  let received: Record<string, unknown> = {};
  const server = await upstream(async (req, res) => {
    received = await body(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ type: "message_start", message: { model: "gpt-5.6-luna", usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "works" } })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}\n\n`);
  });
  const proxy = await createModelTestProxy(server.baseUrl, {
    expectedModel: "gpt-5.6-luna",
    maxOutputTokens: 128,
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", max_tokens: 500, tools: [{ name: "unused" }] }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual(proxy.evidence().usage, {
      inputTokens: 109,
      outputTokens: 3,
      totalTokens: 112,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 7,
    });
    assert.equal(received.max_tokens, 128);
    assert.equal("tools" in received, false);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("model test proxy rejects conflicting model observations in either order", async (context) => {
  for (const [first, last] of [
    ["gpt-5.6-sol", "gpt-5.6-luna"],
    ["gpt-5.6-luna", "gpt-5.6-sol"],
  ]) {
    await context.test(`${first} then ${last}`, async () => {
      await assert.rejects(
        streamEvidence([
          { model: first, choices: [{ delta: { content: "works" } }] },
          {
            model: last,
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
          },
        ]),
        /did not match/,
      );
    });
  }
});

test("model test proxy rejects missing or malformed usage evidence", async (context) => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ["empty", {}],
    ["missing output", { prompt_tokens: 11, total_tokens: 11 }],
    ["negative", { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }],
    ["decimal", { prompt_tokens: 11.5, completion_tokens: 2, total_tokens: 13.5 }],
    ["numeric string", { prompt_tokens: "11", completion_tokens: 2, total_tokens: 13 }],
  ];
  for (const [name, usage] of variants) {
    await context.test(name, async () => {
      await assert.rejects(
        streamEvidence([
          { model: "gpt-5.6-luna", choices: [{ delta: { content: "works" } }] },
          { model: "gpt-5.6-luna", choices: [{ delta: {}, finish_reason: "stop" }], usage },
        ]),
        /did not match/,
      );
    });
  }
});

test("model test proxy rejects decreasing usage that hides an over-cap observation", async () => {
  await assert.rejects(
    streamEvidence([
      {
        model: "gpt-5.6-luna",
        choices: [{ delta: { content: "works" } }],
        usage: { prompt_tokens: 11, completion_tokens: 200, total_tokens: 211 },
      },
      {
        model: "gpt-5.6-luna",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      },
    ]),
    /did not match/,
  );
});
