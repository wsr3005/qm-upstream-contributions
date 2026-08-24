import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; actor: string | null; signed: boolean; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
      body,
    });
    if ((JSON.parse(body || "{}") as { requestId?: string }).requestId === "request-busy") {
      res.writeHead(409, { "content-type": "application/json", "retry-after": "12" });
      res.end(JSON.stringify({ error: "harness_test_in_progress", retryAfterMs: 12_000 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, modelId: "gpt-5.6-luna", reply: "ready", latencyMs: 1 }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-custom-provider-proxy-secret";
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

test("POST /api/custom-providers/:id/harness-test forwards the paid model test with admin attribution", async () => {
  const response = await fetch(`${base}/api/custom-providers/gateway/harness-test`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ modelId: "gpt-5.6-luna", harness: "codex", requestId: "request-paid" }),
  });
  assert.equal(response.status, 200);
  const call = calls.at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/v1/admin/custom-providers/gateway/harness-test");
  assert.equal(call.actor, "U-admin@acme");
  assert.equal(call.signed, true);
  assert.deepEqual(JSON.parse(call.body), {
    modelId: "gpt-5.6-luna",
    harness: "codex",
    requestId: "request-paid",
  });
});

test("the paid model test forwards the core retry window", async () => {
  const response = await fetch(`${base}/api/custom-providers/gateway/harness-test`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ modelId: "gpt-5.6-luna", harness: "pi", requestId: "request-busy" }),
  });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("retry-after"), "12");
});

test("the paid model test rejects signed-out callers before reaching core", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/api/custom-providers/gateway/harness-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: "gpt-5.6-luna" }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, before);
});
