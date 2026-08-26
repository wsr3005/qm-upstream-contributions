import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { HarnessModelTestError } from "../src/harness/harness.ts";
import {
  CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA,
  CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS,
  signCustomProviderTestReservation,
} from "../src/model/custom-provider-test-reservation.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const ADMIN_BOB = { "content-type": "application/json", "x-admin-actor": "admin-bob@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };

function modelTestEvidence(model: string) {
  return {
    requestedModel: model,
    responseModel: model,
    firstTokenMs: 12,
    totalMs: 40,
    usage: {
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    streamed: true,
    upstreamRequests: 1,
  };
}

afterEach(() => setCustomProviders([], []));

test("generation self-test durably exposes safe partial evidence after an upstream failure", async () => {
  const srv = start(undefined, undefined, async () => {
    throw new HarnessModelTestError("provider_request_failed", { upstreamRequests: 1, responseCompleted: false });
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    const body = JSON.stringify({ modelId: "acme-large", harness: "opencode", requestId: "partial-evidence" });
    const first = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body,
    });
    assert.equal(first.status, 502);
    const firstResult = (await first.json()) as Record<string, unknown>;
    assert.ok(Number.isFinite(firstResult.testedAt));
    assert.deepEqual(
      { ...firstResult, testedAt: 0 },
      {
        error: "provider_test_failed",
        message: "opencode could not complete the saved model request",
        failureCategory: "provider_request_failed",
        upstreamRequests: 1,
        requestId: "partial-evidence",
        providerRevision: 1,
        testedAt: 0,
      },
    );
    const replay = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body,
    });
    assert.equal(replay.status, 502);
    const replayed = (await replay.json()) as Record<string, unknown>;
    assert.equal(replayed.failureCategory, "provider_request_failed");
    assert.equal(replayed.upstreamRequests, 1);
  } finally {
    await srv.close();
  }
});

function start(
  modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 }),
  runtimeSchemaReady?: boolean,
  customProviderHarnessTest?: BuiltApp["customProviderHarnessTest"],
  customProviderHarnessTestFence?: BuiltApp["customProviderHarnessTestFence"],
  reservation?: { candidateCommit: string; secret: string },
): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-route-")) }), {
    modelCredentialFetch,
  });
  if (runtimeSchemaReady !== undefined) {
    built.customProviders.runtimeSchemaReady = async () => runtimeSchemaReady;
    built.customProviders.runtimeSchemaWritable = async () => runtimeSchemaReady;
  }
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    customProviderTestRuns: built.customProviderTestRuns,
    refreshCustomProviders: built.refreshCustomProviders,
    customProviderHarnessTest: customProviderHarnessTest ?? built.customProviderHarnessTest,
    customProviderHarnessTestFence: customProviderHarnessTestFence ?? built.customProviderHarnessTestFence,
    ...(reservation
      ? {
          modelTestCandidateCommit: reservation.candidateCommit,
          modelTestReservationSecret: reservation.secret,
        }
      : {}),
    modelCredentialFetch,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a signed reservation is rechecked against the durable Provider before any paid call", async () => {
  const candidateCommit = "a".repeat(40);
  const secret = "route-formal-reservation-secret-00000001";
  let paidCalls = 0;
  const srv = start(
    undefined,
    undefined,
    async (input) => {
      paidCalls += 1;
      return {
        reply: "ready",
        providerRevision: input.expectedRevision,
        upstreamModelId: input.modelId,
        evidence: modelTestEvidence(input.modelId),
        maxOutputTokens: 128,
      };
    },
    undefined,
    { candidateCommit, secret },
  );
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        models: [{ id: "gpt-5.6-luna" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 200);
    const provider = (await put.json()) as { status: { revision: number } };
    const createdAt = Date.now();
    const selectionModelId = "acme-gateway/gpt-5.6-luna";
    const requestId = `qa-${createHash("sha256").update(`browser:${candidateCommit}:base-v37:admin-pi`).digest("hex")}`;
    const reservation = signCustomProviderTestReservation(
      {
        schemaVersion: CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA,
        candidateCommit,
        runAlias: "base-v37",
        budgetRequestId: "admin-pi",
        requestId,
        orgScope: "org:default-org",
        providerId: "acme-gateway",
        selectionModelId,
        upstreamModelId: "gpt-5.6-luna",
        harness: "pi",
        protocol: "openai-responses",
        providerRevision: provider.status.revision,
        createdAt,
        expiresAt: createdAt + CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS,
        storageKey: "qm-custom-provider-test-retry:org%3Adefault-org:acme-gateway:acme-gateway%2Fgpt-5.6-luna:pi",
      },
      secret,
    );
    const validation = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test-reservation`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ reservation }),
    });
    assert.equal(validation.status, 200);

    const update = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        baseUrl: "https://changed.example/v1",
        models: [{ id: "gpt-5.6-luna" }],
        validate: false,
      }),
    });
    assert.equal(update.status, 200);

    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: selectionModelId, harness: "pi", requestId, reservation }),
    });
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_reservation_invalid");
    assert.equal(paidCalls, 0);
  } finally {
    await srv.close();
  }
});

const BODY = {
  name: "Acme Gateway",
  protocol: "openai",
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large" }],
  apiKey: "sk-acme-secret",
};

test("custom provider lifecycle: register, list, resolve, delete — admin only, no key leakage", async () => {
  const validated: string[] = [];
  const srv = start(
    async (input) => {
      validated.push(String(input));
      return new Response(null, { status: 200 });
    },
    undefined,
    async (input) => ({
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    }),
  );
  try {
    // Register (validates against the endpoint's /models).
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 200);
    assert.ok(validated.some((u) => u === "https://llm.acme.internal/v1/models"));
    const putBody = (await put.json()) as { status: { hasKey: boolean } };
    assert.equal(putBody.status.hasKey, true);
    assert.equal(JSON.stringify(putBody).includes("sk-acme-secret"), false);

    assert.equal(resolveModel("acme-large"), undefined);
    for (const harness of ["pi", "opencode"]) {
      const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ modelId: "acme-large", harness, requestId: `publish-${harness}` }),
      });
      assert.equal(tested.status, 200);
    }
    const status = (await srv.built.customProviders.statuses())[0]!;
    const publish = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/publish`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ revision: status.revision }),
    });
    assert.equal(publish.status, 200);

    assert.equal(String(resolveModel("acme-large")?.provider), "acme-gateway");

    // List never leaks the key.
    const list = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);
    const listBody = await list.text();
    assert.equal(listBody.includes("sk-acme-secret"), false);
    assert.ok(listBody.includes("acme-gateway"));

    // Non-admin gets refused.
    const denied = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: USER });
    assert.notEqual(denied.status, 200);
    const deniedTest = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: USER,
      body: JSON.stringify({ modelId: "acme-large", requestId: "request-denied" }),
    });
    assert.notEqual(deniedTest.status, 200);

    // Delete disables and clears the registry.
    const del = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);
    assert.equal(resolveModel("acme-large"), undefined);
  } finally {
    await srv.close();
  }
});

test("generation self-test requires an active stored key", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, apiKey: undefined, validate: false }),
    });
    assert.equal(put.status, 200);
    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", requestId: "request-missing-key" }),
    });
    assert.equal(tested.status, 400);
    assert.deepEqual(await tested.json(), {
      error: "missing_api_key",
      message: "this provider has no active API key",
      requestId: "request-missing-key",
    });
  } finally {
    await srv.close();
  }
});

test("generation self-test can exercise the default built-in model id as an unsaved draft", async () => {
  const calls: Array<{ draft: unknown; harnessId: string; modelId: string }> = [];
  const srv = start(undefined, undefined, async (input) => {
    calls.push({ draft: input.draft, harnessId: input.harnessId, modelId: input.modelId });
    return {
      reply: "draft ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: "gpt-5.6-luna",
      evidence: modelTestEvidence("gpt-5.6-luna"),
      maxOutputTokens: 128,
    };
  });
  try {
    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/draft-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        modelId: "gpt-5.6-luna",
        harness: "pi",
        requestId: "draft-before-save",
        draft: {
          name: "Draft Gateway",
          protocol: "openai",
          baseUrl: "https://draft.example/v1",
          apiKey: "sk-draft-secret",
          models: [{ id: "gpt-5.6-luna" }],
        },
      }),
    });
    assert.equal(tested.status, 200);
    assert.equal(((await tested.clone().json()) as { modelId: string }).modelId, "gpt-5.6-luna");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.harnessId, "pi");
    assert.equal(calls[0]?.modelId, "draft-gateway/gpt-5.6-luna");
    assert.equal((calls[0]?.draft as { apiKey: string }).apiKey, "sk-draft-secret");
    assert.deepEqual((calls[0]?.draft as { provider: { models: unknown } }).provider.models, [
      { id: "draft-gateway/gpt-5.6-luna", upstreamId: "gpt-5.6-luna" },
    ]);
    assert.deepEqual(await srv.built.customProviders.statuses(), []);
  } finally {
    await srv.close();
  }
});

test("generation self-test refuses to spend when durable audit admission fails", async () => {
  let calls = 0;
  const srv = start(undefined, undefined, async (input) => {
    calls += 1;
    return {
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 200);
    srv.built.auditLog.recordOnce = async () => {
      throw new Error("audit unavailable");
    };
    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "audit-failure" }),
    });
    assert.equal(tested.status, 503);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_audit_unavailable");
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test("generation self-test audit keys isolate every paid claim across providers", async () => {
  const srv = start(undefined, undefined, async (input) => ({
    reply: "ready",
    providerRevision: input.expectedRevision,
    upstreamModelId: input.modelId,
    evidence: modelTestEvidence(input.modelId),
    maxOutputTokens: 128,
  }));
  try {
    for (const [provider, model] of [
      ["gateway-a", "model-a"],
      ["gateway-b", "model-b"],
    ]) {
      const put = await fetch(`${srv.base}/v1/admin/custom-providers/${provider}`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ ...BODY, name: provider, models: [{ id: model }], validate: false }),
      });
      assert.equal(put.status, 200);
    }
    const auditKeys = new Set<string>();
    srv.built.auditLog.recordOnce = async (key) => {
      auditKeys.add(key);
    };
    for (const [provider, model] of [
      ["gateway-a", "model-a"],
      ["gateway-b", "model-b"],
    ]) {
      const tested = await fetch(`${srv.base}/v1/admin/custom-providers/${provider}/harness-test`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ modelId: model, harness: "pi", requestId: "shared-request-id" }),
      });
      assert.equal(tested.status, 200);
    }
    assert.equal(auditKeys.size, 4);
  } finally {
    await srv.close();
  }
});

test("generation self-test keeps the paid outcome unknown when terminal audit fails", async () => {
  const srv = start(undefined, undefined, async () => {
    throw new Error("upstream failed after admission");
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    srv.built.auditLog.recordOnce = async (key) => {
      if (key.endsWith(":failed")) throw new Error("terminal audit unavailable");
    };
    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "terminal-audit-failure" }),
    });
    assert.equal(tested.status, 503);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_audit_unavailable");
  } finally {
    await srv.close();
  }
});

test("generation self-test dispatches the selected real harness", async () => {
  const calls: Array<{ harnessId: string; modelId: string }> = [];
  const srv = start(undefined, undefined, async (input) => {
    calls.push({ harnessId: input.harnessId, modelId: input.modelId });
    return {
      reply: `${input.harnessId} ready`,
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: input.harnessId === "pi" ? 64 : 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        models: [{ id: "responses-model" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    for (const harness of ["pi", "opencode", "codex"]) {
      const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ modelId: "responses-model", harness, requestId: `request-${harness}` }),
      });
      assert.equal(tested.status, 200);
      const result = (await tested.json()) as {
        harness: string;
        reply: string;
        requestedModel: string;
        responseModel: string;
        endpointAlias: string;
        noDefaultEgress: boolean;
        providerRevision: number;
        testedAt: number;
        maxOutputTokens: number;
      };
      assert.equal(result.harness, harness);
      assert.equal(result.reply, `${harness} ready`);
      assert.equal(result.requestedModel, "responses-model");
      assert.equal(result.responseModel, "responses-model");
      assert.equal(result.endpointAlias, "Acme Gateway");
      assert.equal(result.noDefaultEgress, true);
      assert.equal(result.providerRevision, 1);
      assert.equal(result.maxOutputTokens, harness === "pi" ? 64 : 128);
      assert.ok(Number.isFinite(result.testedAt));
    }
    assert.deepEqual(calls, [
      { harnessId: "pi", modelId: "responses-model" },
      { harnessId: "opencode", modelId: "responses-model" },
      { harnessId: "codex", modelId: "responses-model" },
    ]);
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.ok(audits.every((event) => event.detail?.includes("requestIdHash=")));
    assert.ok(audits.every((event) => !event.detail?.includes("requestFingerprint=")));
    assert.ok(audits.every((event) => !event.detail?.includes("request-pi")));

    const invalid = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "responses-model", harness: "slack", requestId: "request-invalid" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 3);

    const missingRequestId = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "responses-model", harness: "pi" }),
    });
    assert.equal(missingRequestId.status, 400);
    assert.match(((await missingRequestId.json()) as { message: string }).message, /requestId is required/);
    assert.equal(calls.length, 3);

    const chatOnly = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, models: [{ id: "responses-model" }], validate: false }),
    });
    assert.equal(chatOnly.status, 200);
    const unsupported = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "responses-model", harness: "codex", requestId: "request-unsupported" }),
    });
    assert.equal(unsupported.status, 400);
    assert.equal(((await unsupported.json()) as { error: string; requestId: string }).requestId, "request-unsupported");
    assert.equal(calls.length, 3);
  } finally {
    await srv.close();
  }
});

test("generation self-test rejects incomplete or unsafe model evidence", async () => {
  const variants = [
    { evidence: undefined, maxOutputTokens: 128 },
    {
      evidence: { ...modelTestEvidence("responses-model"), responseModel: "gpt-5.6-sol" },
      maxOutputTokens: 128,
    },
    { evidence: { ...modelTestEvidence("responses-model"), streamed: false }, maxOutputTokens: 128 },
    {
      evidence: {
        ...modelTestEvidence("responses-model"),
        usage: {
          inputTokens: 5,
          outputTokens: 129,
          totalTokens: 134,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      maxOutputTokens: 128,
    },
    {
      evidence: {
        ...modelTestEvidence("responses-model"),
        usage: {
          inputTokens: -1,
          outputTokens: 3,
          totalTokens: 2,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      maxOutputTokens: 128,
    },
    {
      evidence: {
        ...modelTestEvidence("responses-model"),
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 7,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      maxOutputTokens: 128,
    },
    {
      evidence: {
        ...modelTestEvidence("responses-model"),
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
          cachedInputTokens: 6,
          cacheCreationInputTokens: 0,
        },
      },
      maxOutputTokens: 128,
    },
    {
      evidence: {
        ...modelTestEvidence("responses-model"),
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 3,
        },
      },
      maxOutputTokens: 128,
    },
    {
      evidence: { ...modelTestEvidence("responses-model"), firstTokenMs: 41, totalMs: 40 },
      maxOutputTokens: 128,
    },
    {
      evidence: { ...modelTestEvidence("responses-model"), upstreamRequests: 2 },
      maxOutputTokens: 128,
    },
    { evidence: modelTestEvidence("responses-model"), maxOutputTokens: 129 },
  ];
  let calls = 0;
  const srv = start(undefined, undefined, async (input) => {
    const variant = variants[calls++];
    assert.ok(variant);
    return {
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      ...variant,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        models: [{ id: "responses-model" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 200);
    for (let index = 0; index < variants.length; index += 1) {
      const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({
          modelId: "responses-model",
          harness: "pi",
          requestId: `request-unsafe-${index}`,
        }),
      });
      assert.equal(tested.status, 502);
      const result = (await tested.json()) as Record<string, unknown>;
      assert.equal(result.error, "provider_test_failed");
      assert.equal(result.message, "the model response could not be verified");
      assert.equal(result.requestId, `request-unsafe-${index}`);
      assert.equal(result.providerRevision, 1);
      assert.ok(Number.isFinite(result.testedAt));
    }
    assert.equal(calls, variants.length);
  } finally {
    await srv.close();
  }
});

test("generation self-test admits one paid call across independent admin clients and replays its result", async () => {
  let calls = 0;
  let notifyStarted!: () => void;
  let releaseRunner!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const srv = start(undefined, undefined, async (input) => {
    calls += 1;
    notifyStarted();
    await released;
    return {
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    const url = `${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`;
    const ownerBody = JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-owner" });
    const waiterBody = JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-waiter" });
    const firstPending = fetch(url, { method: "POST", headers: ADMIN, body: ownerBody });
    await started;

    const duplicate = await fetch(url, { method: "POST", headers: ADMIN_BOB, body: waiterBody });
    assert.equal(duplicate.status, 409);
    const busy = (await duplicate.json()) as {
      error: string;
      replayExpected: boolean;
      requestExpiresInMs: number;
      retryAfterMs: number;
    };
    assert.equal(busy.error, "harness_test_in_progress");
    assert.equal(busy.replayExpected, true);
    assert.ok(busy.retryAfterMs > 0 && busy.retryAfterMs <= 2_000);
    assert.ok(busy.requestExpiresInMs > busy.retryAfterMs);
    assert.equal(duplicate.headers.get("retry-after"), "2");
    assert.equal(calls, 1);

    releaseRunner();
    const first = await firstPending;
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { cached?: boolean }).cached, undefined);

    const replay = await fetch(url, { method: "POST", headers: ADMIN_BOB, body: waiterBody });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as { cached: boolean; reply: string };
    assert.equal(replayed.cached, true);
    assert.equal(replayed.reply, "ready");
    assert.equal(calls, 1);

    const ownerReplay = await fetch(url, { method: "POST", headers: ADMIN, body: ownerBody });
    assert.equal(ownerReplay.status, 200);
    assert.equal(((await ownerReplay.json()) as { cached: boolean }).cached, true);
    assert.equal(calls, 1);

    const fresh = await fetch(url, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-fresh" }),
    });
    assert.equal(fresh.status, 200);
    assert.equal(((await fresh.json()) as { cached?: boolean }).cached, undefined);
    assert.equal(calls, 2);
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.deepEqual(
      audits.map((event) => event.status),
      ["attempted", "busy", "succeeded", "replayed", "replayed", "attempted", "succeeded"],
    );
  } finally {
    releaseRunner();
    await srv.close();
  }
});

test("generation self-test persists a paid result after the requesting client disconnects", async () => {
  let calls = 0;
  let notifyStarted!: () => void;
  let releaseRunner!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const srv = start(undefined, undefined, async (input) => {
    calls += 1;
    notifyStarted();
    await released;
    return {
      reply: "survived disconnect",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    const url = `${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`;
    const body = JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-disconnected" });
    const controller = new AbortController();
    const disconnected = fetch(url, { method: "POST", headers: ADMIN, body, signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(disconnected, (error: Error) => error.name === "AbortError");
    releaseRunner();

    let replayed: { cached: boolean; reply: string } | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const retry = await fetch(url, { method: "POST", headers: ADMIN_BOB, body });
      if (retry.status === 200) {
        replayed = (await retry.json()) as { cached: boolean; reply: string };
        break;
      }
      assert.equal(retry.status, 409);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(replayed?.cached, true);
    assert.equal(replayed?.reply, "survived disconnect");
    assert.equal(calls, 1);
  } finally {
    releaseRunner();
    await srv.close();
  }
});

test("generation self-test does not spend when the durable billing guard cannot claim", async () => {
  let calls = 0;
  const srv = start(undefined, undefined, async (input) => {
    calls += 1;
    return {
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    srv.built.customProviderTestRuns.claim = async () => {
      throw new Error("store unavailable");
    };
    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-guard" }),
    });
    assert.equal(tested.status, 503);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_guard_unavailable");
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test("generation self-test does not spend when an old request receipt has no recoverable result", async () => {
  let calls = 0;
  const srv = start(undefined, undefined, async (input) => {
    calls += 1;
    return {
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    srv.built.customProviderTestRuns.claim = async () => ({
      kind: "unresolved",
      retryAfterMs: 3_000,
      requestExpiresAt: Date.now() + 3_000,
    });
    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-unresolved" }),
    });
    assert.equal(tested.status, 409);
    assert.equal(tested.headers.get("retry-after"), "3");
    const result = (await tested.json()) as { error: string; requestExpiresInMs: number };
    assert.equal(result.error, "harness_test_result_unresolved");
    assert.ok(result.requestExpiresInMs > 0 && result.requestExpiresInMs <= 3_000);
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test("generation self-test keeps the safety window closed when paid-result persistence fails", async () => {
  let calls = 0;
  const srv = start(undefined, undefined, async (input) => {
    calls += 1;
    return {
      reply: "ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: input.modelId,
      evidence: modelTestEvidence(input.modelId),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);
    srv.built.customProviderTestRuns.complete = async () => {
      throw new Error("store unavailable");
    };
    const url = `${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`;
    const body = JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-unpersisted" });
    const tested = await fetch(url, { method: "POST", headers: ADMIN, body });
    assert.equal(tested.status, 503);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_result_not_durable");
    assert.equal(calls, 1);

    const retry = await fetch(url, { method: "POST", headers: ADMIN_BOB, body });
    assert.equal(retry.status, 409);
    assert.equal(((await retry.json()) as { error: string }).error, "harness_test_in_progress");
    assert.equal(calls, 1);
  } finally {
    await srv.close();
  }
});

test("generation self-test stays closed until every live runtime supports its protocol", async () => {
  let calls = 0;
  const srv = start(
    undefined,
    undefined,
    async (input) => {
      calls += 1;
      return {
        reply: "ready",
        providerRevision: input.expectedRevision,
        upstreamModelId: input.modelId,
        evidence: modelTestEvidence(input.modelId),
        maxOutputTokens: 128,
      };
    },
    async () => null,
  );
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);

    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-rollout-closed" }),
    });
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_rollout_incomplete");
    assert.equal(calls, 0);

    const legacy = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large" }),
    });
    assert.equal(legacy.status, 404);
  } finally {
    await srv.close();
  }
});

test("generation self-test cannot report success when the rollout fence changes in flight", async () => {
  let rolloutFence = "epoch-1";
  let calls = 0;
  let notifyStarted!: () => void;
  let releaseRunner!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const srv = start(
    undefined,
    undefined,
    async (input) => {
      calls += 1;
      notifyStarted();
      await released;
      return {
        reply: "ready",
        providerRevision: input.expectedRevision,
        upstreamModelId: input.modelId,
        evidence: modelTestEvidence(input.modelId),
        maxOutputTokens: 128,
      };
    },
    async () => rolloutFence,
  );
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);

    const pending = fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-rollout-change" }),
    });
    await started;
    rolloutFence = "epoch-2";
    const blocked = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN_BOB,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-rollout-waiter" }),
    });
    assert.equal(blocked.status, 409);
    const busy = (await blocked.json()) as { error: string; replayExpected: boolean };
    assert.equal(busy.error, "harness_test_in_progress");
    assert.equal(busy.replayExpected, false);
    assert.equal(calls, 1);
    releaseRunner();

    const tested = await pending;
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_rollout_incomplete");
    const conflict = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-rollout-change" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "harness_test_request_conflict");
    assert.equal(calls, 1);
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.deepEqual(
      audits.map((event) => event.status),
      ["attempted", "busy", "failed", "conflict"],
    );
  } finally {
    releaseRunner();
    await srv.close();
  }
});

test("generation self-test sees a provider update completed during its final fence read", async () => {
  let runnerFinished = false;
  let finalFenceBlocked = false;
  let notifyFinalFence!: () => void;
  let releaseFinalFence!: () => void;
  const finalFenceStarted = new Promise<void>((resolve) => {
    notifyFinalFence = resolve;
  });
  const finalFenceReleased = new Promise<void>((resolve) => {
    releaseFinalFence = resolve;
  });
  const srv = start(
    undefined,
    undefined,
    async (input) => {
      runnerFinished = true;
      return {
        reply: "old revision ready",
        providerRevision: input.expectedRevision,
        upstreamModelId: "wire-old",
        evidence: modelTestEvidence("wire-old"),
        maxOutputTokens: 128,
      };
    },
    async () => {
      if (runnerFinished && !finalFenceBlocked) {
        finalFenceBlocked = true;
        notifyFinalFence();
        await finalFenceReleased;
      }
      return "epoch-1";
    },
  );
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        models: [{ id: "race-model", upstreamId: "wire-old" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    const pending = fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "race-model", harness: "pi", requestId: "request-final-fence" }),
    });
    await finalFenceStarted;
    const update = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        apiKey: "sk-new-secret",
        models: [{ id: "race-model", upstreamId: "wire-new" }],
        validate: false,
      }),
    });
    assert.equal(update.status, 200);
    releaseFinalFence();

    const tested = await pending;
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "provider_changed_during_test");
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.deepEqual(
      audits.map((event) => event.status),
      ["attempted", "failed"],
    );
  } finally {
    releaseFinalFence();
    await srv.close();
  }
});

test("generation self-test sees a rollout change between its final fence and provider snapshots", async () => {
  let runnerFinished = false;
  let finalFenceReads = 0;
  const srv = start(
    undefined,
    undefined,
    async (input) => {
      runnerFinished = true;
      return {
        reply: "ready",
        providerRevision: input.expectedRevision,
        upstreamModelId: input.modelId,
        evidence: modelTestEvidence(input.modelId),
        maxOutputTokens: 128,
      };
    },
    async () => {
      if (!runnerFinished) return "epoch-1";
      finalFenceReads += 1;
      return finalFenceReads === 1 ? "epoch-1" : "epoch-2";
    },
  );
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(put.status, 200);

    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "acme-large", harness: "pi", requestId: "request-fence-snapshot" }),
    });
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_rollout_incomplete");
    assert.equal(finalFenceReads, 2);
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.deepEqual(
      audits.map((event) => event.status),
      ["attempted", "failed"],
    );
  } finally {
    await srv.close();
  }
});

test("generation self-test cannot report success for a provider revision changed in flight", async () => {
  let notifyStarted!: () => void;
  let releaseRunner!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const srv = start(undefined, undefined, async (input) => {
    notifyStarted();
    await released;
    return {
      reply: "old revision ready",
      providerRevision: input.expectedRevision,
      upstreamModelId: "wire-old",
      evidence: modelTestEvidence("wire-old"),
      maxOutputTokens: 128,
    };
  });
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        models: [{ id: "race-model", upstreamId: "wire-old" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    const pending = fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "race-model", harness: "pi", requestId: "request-provider-change" }),
    });
    await started;

    const update = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        protocol: "openai-responses",
        apiKey: "sk-new-secret",
        models: [{ id: "race-model", upstreamId: "wire-new" }],
        validate: false,
      }),
    });
    assert.equal(update.status, 200);
    releaseRunner();

    const tested = await pending;
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "provider_changed_during_test");
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.deepEqual(
      audits.map((event) => event.status),
      ["attempted", "failed"],
    );
    assert.ok(audits.every((event) => event.detail?.includes("upstreamModelId=wire-old")));
  } finally {
    releaseRunner();
    await srv.close();
  }
});

test("a rejected key blocks registration unless validate:false", async () => {
  const srv = start(async () => new Response(null, { status: 401 }));
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 400);
    assert.equal(((await put.json()) as { error: string }).error, "invalid_api_key");

    const skip = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(skip.status, 200);
  } finally {
    await srv.close();
  }
});

test("bad specs are refused with a reason", async () => {
  const srv = start();
  try {
    for (const [patch, reason] of [
      [{ models: [] }, /at least one model/],
      [{ protocol: "grpc" }, /protocol/],
      [{ baseUrl: "https://x?y=1" }, /query/],
      [{ models: [{ id: "acme-large", contextWindow: 0 }] }, /positive integer/],
      [{ models: [{ id: "acme-large", maxTokens: 1.5 }] }, /positive integer/],
    ] as const) {
      const res = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ ...BODY, ...patch, validate: false }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { message: string }).message, reason);
    }
    // Reserved slug via the path.
    const reserved = await fetch(`${srv.base}/v1/admin/custom-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(reserved.status, 400);
    assert.match(((await reserved.json()) as { message: string }).message, /reserved/);
  } finally {
    await srv.close();
  }
});

test("null JSON bodies return a client error", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: "null",
    });
    assert.equal(put.status, 400);
    assert.equal(((await put.json()) as { error: string }).error, "bad_request");

    const tested = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: "null",
    });
    assert.equal(tested.status, 400);
    assert.equal(((await tested.json()) as { error: string }).error, "bad_request");
  } finally {
    await srv.close();
  }
});

test("model aliases remain inactive until every runtime supports wire ids", async () => {
  const srv = start(undefined, false);
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        models: [{ id: "acme-luna", upstreamId: "gpt-5.6-luna" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 409);
    assert.equal(((await put.json()) as { error: string }).error, "runtime_rollout_incomplete");
    assert.equal(resolveModel("acme-luna"), undefined);
  } finally {
    await srv.close();
  }
});

test("image capability remains inactive until every runtime supports schema 2", async () => {
  const srv = start(undefined, false);
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        models: [{ id: "acme-luna", inputModalities: ["text", "image"] }],
        validate: false,
      }),
    });
    assert.equal(put.status, 409);
    assert.equal(((await put.json()) as { error: string }).error, "runtime_rollout_incomplete");
    assert.equal(resolveModel("acme-luna"), undefined);
  } finally {
    await srv.close();
  }
});
