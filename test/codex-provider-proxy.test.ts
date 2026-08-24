import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createCodexProviderProxy } from "../src/harness/codex-provider-proxy.ts";

test("Codex custom provider proxy removes the Responses Lite header", async (t) => {
  const requests: Array<{ url?: string; lite?: string; retained?: string; body: string }> = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        lite: req.headers["x-openai-internal-codex-responses-lite"] as string | undefined,
        retained: req.headers["x-client-request-id"] as string | undefined,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const proxy = await createCodexProviderProxy(upstreamBase);
  t.after(async () => {
    await proxy.close();
    upstream.close();
  });

  const response = await fetch(`${proxy.baseUrl}/responses?mode=test`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-request-id": "request-1",
      "x-openai-internal-codex-responses-lite": "true",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(requests, [
    {
      url: "/v1/responses?mode=test",
      lite: undefined,
      retained: "request-1",
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
    },
  ]);
});

test("Codex custom provider proxy aborts upstream when the downstream stream closes", async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
  const upstream = createServer((req, res) => {
    res.once("close", upstreamClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const proxy = await createCodexProviderProxy(upstreamBase);

  const downstreamClosed = new Promise<void>((resolve, reject) => {
    const client = request(`${proxy.baseUrl}/responses`, { method: "POST" });
    client.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
      else reject(error);
    });
    client.once("response", (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    client.end(JSON.stringify({ model: "gpt-5.6-luna" }));
  });

  await downstreamClosed;
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upstream request stayed open")), 1_000)),
  ]);
  await Promise.race([
    proxy.close(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("proxy close stayed blocked")), 1_000)),
  ]);
  upstream.close();
});
