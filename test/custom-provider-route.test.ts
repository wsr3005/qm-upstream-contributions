import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
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

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };

afterEach(() => setCustomProviders([], []));

function start(
  modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 }),
  runtimeSchemaReady?: boolean,
  customProviderHarnessTest?: BuiltApp["customProviderHarnessTest"],
  customProviderHarnessTestFence?: BuiltApp["customProviderHarnessTestFence"],
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
    refreshCustomProviders: built.refreshCustomProviders,
    customProviderHarnessTest: customProviderHarnessTest ?? built.customProviderHarnessTest,
    customProviderHarnessTestFence: customProviderHarnessTestFence ?? built.customProviderHarnessTestFence,
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

const BODY = {
  name: "Acme Gateway",
  protocol: "openai",
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large" }],
  apiKey: "sk-acme-secret",
};

test("custom provider lifecycle: register, list, resolve, delete — admin only, no key leakage", async () => {
  const validated: string[] = [];
  const srv = start(async (input) => {
    validated.push(String(input));
    return new Response(null, { status: 200 });
  });
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

    // The runtime registry serves the model immediately.
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
      body: JSON.stringify({ modelId: "acme-large" }),
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
      body: JSON.stringify({ modelId: "acme-large" }),
    });
    assert.equal(tested.status, 400);
    assert.equal(((await tested.json()) as { error: string }).error, "missing_api_key");
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
        body: JSON.stringify({ modelId: "responses-model", harness }),
      });
      assert.equal(tested.status, 200);
      const result = (await tested.json()) as { harness: string; reply: string };
      assert.equal(result.harness, harness);
      assert.equal(result.reply, `${harness} ready`);
    }
    assert.deepEqual(calls, [
      { harnessId: "pi", modelId: "responses-model" },
      { harnessId: "opencode", modelId: "responses-model" },
      { harnessId: "codex", modelId: "responses-model" },
    ]);

    const invalid = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway/harness-test`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "responses-model", harness: "slack" }),
    });
    assert.equal(invalid.status, 400);
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
      body: JSON.stringify({ modelId: "responses-model", harness: "codex" }),
    });
    assert.equal(unsupported.status, 400);
    assert.equal(((await unsupported.json()) as { error: string }).error, "harness_not_supported");
    assert.equal(calls.length, 3);
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
      body: JSON.stringify({ modelId: "acme-large", harness: "pi" }),
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
      notifyStarted();
      await released;
      return {
        reply: "ready",
        providerRevision: input.expectedRevision,
        upstreamModelId: input.modelId,
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
      body: JSON.stringify({ modelId: "acme-large", harness: "pi" }),
    });
    await started;
    rolloutFence = "epoch-2";
    releaseRunner();

    const tested = await pending;
    assert.equal(tested.status, 409);
    assert.equal(((await tested.json()) as { error: string }).error, "harness_test_rollout_incomplete");
    const audits = (await srv.built.auditLog.events()).filter((event) => event.action === "custom-providers.test");
    assert.deepEqual(
      audits.map((event) => event.status),
      ["attempted", "failed"],
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
      body: JSON.stringify({ modelId: "race-model", harness: "pi" }),
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
      body: JSON.stringify({ modelId: "acme-large", harness: "pi" }),
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
      body: JSON.stringify({ modelId: "race-model", harness: "pi" }),
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
