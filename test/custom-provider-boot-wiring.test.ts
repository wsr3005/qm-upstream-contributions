import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { defaultModelForHarness } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import {
  CUSTOM_PROVIDER_HARNESS_TEST_CAPABILITY,
  CUSTOM_PROVIDER_INPUT_MODALITIES_CAPABILITY,
  CUSTOM_PROVIDER_PUBLICATION_CAPABILITY,
} from "../src/model/custom-provider-store.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

afterEach(() => setCustomProviders([], []));

test("durable production instances require a build id for capability registration", () => {
  assert.throws(
    () =>
      buildApp(
        testConfig({
          dataDir: mkdtempSync(join(tmpdir(), "custom-provider-build-id-")),
          production: true,
          databaseUrl: "postgres://unused.invalid/qm",
          buildSha: undefined,
        }),
      ),
    /GIT_SHA is required/,
  );
});

test("serverDeps wires the custom-provider store and resolves a custom boot default lazily", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "custom-provider-boot-")),
    harness: "pi",
    modelId: "acme-large",
  });
  const built = buildApp(config, { modelCredentialFetch: async () => new Response(null, { status: 200 }) });
  const deps = serverDeps(config, built);
  assert.equal(deps.customProviders, built.customProviders);
  assert.equal(deps.customProviderTestRuns, built.customProviderTestRuns);
  assert.equal(deps.refreshCustomProviders, built.refreshCustomProviders);
  assert.equal(deps.customProviderHarnessTestFence, built.customProviderHarnessTestFence);
  assert.equal(deps.baseModelDefault, "acme-large");

  const server = createInsecureTestServer(built.app, deps);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    assert.notEqual(defaultModelForHarness("pi", deps.baseModelDefault), "acme-large");

    const list = await fetch(`${base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);

    const put = await fetch(`${base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "Acme Gateway",
        protocol: "openai",
        baseUrl: "https://llm.acme.internal/v1",
        models: [{ id: "acme-large", name: "Acme Large" }],
        apiKey: "sk-acme-secret",
        validate: false,
      }),
    });
    assert.equal(put.status, 200);

    assert.notEqual(defaultModelForHarness("pi", deps.baseModelDefault), "acme-large");
    const status = (await built.customProviders.statuses())[0]!;
    assert.equal(status.published, false);
    assert.equal(
      await built.customProviders.recordVerification(status.id, status.revision, "acme-large", "pi", 1),
      true,
    );
    assert.equal(
      await built.customProviders.recordVerification(status.id, status.revision, "acme-large", "opencode", 2),
      true,
    );
    assert.equal(
      await built.customProviders.publish(
        status.id,
        status.revision,
        [
          { modelId: "acme-large", harnessId: "pi" },
          { modelId: "acme-large", harnessId: "opencode" },
        ],
        "admin-alice@default-org",
      ),
      true,
    );
    await built.refreshCustomProviders();

    assert.equal(defaultModelForHarness("pi", deps.baseModelDefault), "acme-large");

    setCustomProviders([], []);
    const surface = await fetch(`${base}/v1/surface-config`, { headers: ADMIN });
    assert.equal(surface.status, 200);
    assert.ok(((await surface.json()) as { webuiModels: string[] }).webuiModels.includes("acme-large"));

    setCustomProviders([], []);
    const selected = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        principalId: "admin-alice@default-org",
        scopeId: "personal:admin-alice@default-org",
        harnessId: "pi",
        modelId: "acme-large",
      }),
    });
    assert.equal(selected.status, 200);

    setCustomProviders([], []);
    const runtime = await fetch(
      `${base}/v1/runtime-config?principalId=admin-alice@default-org&scopeId=personal:admin-alice@default-org`,
      { headers: ADMIN },
    );
    assert.equal(runtime.status, 200);
    const body = (await runtime.json()) as {
      effective: { modelId: string };
      modelsByHarness: Record<string, string[]>;
      modelCatalog: Record<string, { name: string; provider: string }>;
    };
    assert.equal(body.effective.modelId, "acme-large");
    assert.ok(body.modelsByHarness.pi?.includes("acme-large"));
    assert.equal(body.modelCatalog["acme-large"]?.provider, "acme-gateway");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("production harness testing returns a stable fence only when every live runtime advertises the B protocol", async () => {
  let allCapable = false;
  const checked: string[] = [];
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "custom-provider-capability-")),
      production: true,
    }),
    {
      instanceRegistry: {
        beat: async () => false,
        capabilitySnapshot: async (capability) => {
          checked.push(capability);
          return { ready: allCapable, epoch: "epoch-7" };
        },
      },
    },
  );

  assert.equal(await built.customProviderHarnessTestFence(), null);
  allCapable = true;
  assert.equal(await built.customProviderHarnessTestFence(), "epoch-7");
  assert.equal(checked.filter((capability) => capability === CUSTOM_PROVIDER_HARNESS_TEST_CAPABILITY).length, 2);
});

test("production image provider writes use the input-modalities capability fence", async () => {
  const checked: string[] = [];
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "custom-provider-image-capability-")),
      production: true,
    }),
    {
      instanceRegistry: {
        beat: async () => false,
        allLiveSupport: async (capability) => {
          checked.push(capability);
          return capability === CUSTOM_PROVIDER_INPUT_MODALITIES_CAPABILITY;
        },
      },
    },
  );

  await built.customProviders.upsert(
    {
      id: "image-gateway",
      name: "Image Gateway",
      protocol: "openai-responses",
      baseUrl: "https://llm.example.com/v1",
      models: [{ id: "image-model", inputModalities: ["text", "image"] }],
    },
    "sk-image",
    "admin-alice@default-org",
  );

  assert.deepEqual(checked, [CUSTOM_PROVIDER_INPUT_MODALITIES_CAPABILITY]);
  assert.equal((await built.customProviders.statuses())[0]?.disabled, false);
});

test("production staged provider writes require the publication capability fence", async () => {
  const checked: string[] = [];
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "custom-provider-publication-capability-")),
      production: true,
    }),
    {
      instanceRegistry: {
        beat: async () => false,
        allLiveSupport: async (capability) => {
          checked.push(capability);
          return capability === CUSTOM_PROVIDER_PUBLICATION_CAPABILITY;
        },
      },
    },
  );

  await built.customProviders.upsert(
    {
      id: "staged-gateway",
      name: "Staged Gateway",
      protocol: "openai",
      baseUrl: "https://llm.example.com/v1",
      models: [{ id: "staged-model" }],
    },
    "sk-staged",
    "admin-alice@default-org",
    { stage: true },
  );

  assert.deepEqual(checked, [CUSTOM_PROVIDER_PUBLICATION_CAPABILITY]);
  assert.equal((await built.customProviders.statuses())[0]?.published, false);
});

test("web turns refresh durable custom providers before runtime validation", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-turn-refresh-")) }));
  await built.customProviders.upsert(
    {
      id: "fresh-gateway",
      name: "Fresh Gateway",
      protocol: "openai",
      baseUrl: "https://llm.example.com/v1",
      models: [{ id: "fresh-model" }],
    },
    "sk-fresh",
    "admin-alice@default-org",
  );
  setCustomProviders([], []);

  const turn = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:custom-provider-refresh" },
    text: "hello",
    model: "fresh-model",
    async: true,
  });

  assert.equal(turn.status, "queued");
});

test("paid web turns bind the provider revision through queued execution", async () => {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-revision-bound-")), maxAttempts: 1 }),
  );
  await built.customProviders.upsert(
    {
      id: "bound-gateway",
      name: "Bound Gateway",
      protocol: "openai",
      baseUrl: "https://llm.example.com/v1",
      models: [{ id: "bound-model" }],
    },
    "sk-bound",
    "admin-alice@default-org",
  );
  const revision = (await built.customProviders.statuses())[0]!.revision;
  const invalid = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:custom-provider-invalid-revision" },
    text: "hello",
    model: "bound-model",
    modelProviderId: "bound-gateway",
    modelProviderRevision: revision + 1,
    async: true,
  });
  assert.deepEqual(invalid, {
    status: "refused",
    reason: "custom model provider changed; refresh the model configuration and retry",
  });

  const queued = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:custom-provider-revision" },
    text: "hello",
    model: "bound-model",
    modelProviderId: "bound-gateway",
    modelProviderRevision: revision,
    async: true,
  });
  assert.equal(queued.status, "queued");
  if (queued.status !== "queued") return;
  assert.ok(queued.runId);
  const queuedRun = await built.runs.get(queued.runId);
  assert.equal(queuedRun?.request.modelProviderId, "bound-gateway");
  assert.equal(queuedRun?.request.modelProviderRevision, revision);
  await built.customProviders.upsert(
    {
      id: "bound-gateway",
      name: "Bound Gateway Changed",
      protocol: "openai",
      baseUrl: "https://llm.example.com/v2",
      models: [{ id: "bound-model" }],
    },
    "sk-bound-changed",
    "admin-alice@default-org",
  );
  await built.runtime.ready();
  built.runtime.start();
  try {
    const run = await built.runs.waitFor(queued.runId, 5_000);
    assert.equal(run.status, "failed");
    assert.match(
      run.result?.status === "failed" ? (run.result.reason ?? "") : "",
      /custom model provider changed; refresh the model configuration and retry/,
    );
  } finally {
    await built.runtime.stop();
  }
});

test("paid custom model turns reject missing or replaced Provider identities", async () => {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-identity-bound-")), maxAttempts: 1 }),
  );
  await built.customProviders.upsert(
    {
      id: "identity-a",
      name: "Identity A",
      protocol: "openai",
      baseUrl: "https://a.example.com/v1",
      models: [{ id: "shared-model" }],
    },
    "sk-a",
    "admin-alice@default-org",
  );
  const revision = (await built.customProviders.statuses())[0]!.revision;
  const missing = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:custom-provider-missing-identity" },
    text: "hello",
    model: "shared-model",
    idempotencyKey: "paid-missing-identity",
    async: true,
  });
  assert.deepEqual(missing, {
    status: "refused",
    reason: "custom model provider changed; refresh the model configuration and retry",
  });

  await built.customProviders.delete("identity-a", "admin-alice@default-org");
  await built.customProviders.upsert(
    {
      id: "identity-b",
      name: "Identity B",
      protocol: "openai",
      baseUrl: "https://b.example.com/v1",
      models: [{ id: "shared-model" }],
    },
    "sk-b",
    "admin-alice@default-org",
  );
  const replaced = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:custom-provider-replaced-identity" },
    text: "hello",
    model: "shared-model",
    modelProviderId: "identity-a",
    modelProviderRevision: revision,
    idempotencyKey: "paid-replaced-identity",
    async: true,
  });
  assert.deepEqual(replaced, {
    status: "refused",
    reason: "custom model provider changed; refresh the model configuration and retry",
  });
});

test("workers reject historical custom model runs without Provider bindings", async () => {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-historical-unbound-")), maxAttempts: 1 }),
  );
  await built.customProviders.upsert(
    {
      id: "historical-gateway",
      name: "Historical Gateway",
      protocol: "openai",
      baseUrl: "https://historical.example.com/v1",
      models: [{ id: "historical-model" }],
    },
    "sk-historical",
    "admin-alice@default-org",
  );
  const prepared = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:custom-provider-historical-unbound" },
    text: "hello",
    model: "historical-model",
    async: true,
  });
  assert.equal(prepared.status, "queued");
  if (prepared.status !== "queued") return;
  assert.ok(prepared.runId);
  const preparedRun = await built.runs.get(prepared.runId);
  assert.ok(preparedRun);
  await built.runs.withdraw(prepared.runId);
  const legacyRequest = { ...preparedRun.request };
  delete legacyRequest.modelProviderId;
  delete legacyRequest.modelProviderRevision;
  const legacy = await built.runs.enqueue({
    sessionId: "web:alice:custom-provider-historical-unbound",
    request: legacyRequest,
    maxAttempts: 1,
  });
  await built.runtime.ready();
  built.runtime.start();
  try {
    const run = await built.runs.waitFor(legacy.run.id, 5_000);
    assert.equal(run.status, "failed");
    assert.match(
      run.result?.status === "failed" ? (run.result.reason ?? "") : "",
      /custom model provider changed; refresh the model configuration and retry/,
    );
  } finally {
    await built.runtime.stop();
  }
});

test("non-Web custom model turns persist Provider bindings before enqueue", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-dingtalk-bound-")) }));
  await built.customProviders.upsert(
    {
      id: "dingtalk-gateway",
      name: "DingTalk Gateway",
      protocol: "openai",
      baseUrl: "https://dingtalk.example.com/v1",
      models: [{ id: "dingtalk-model" }],
    },
    "sk-dingtalk",
    "admin-alice@default-org",
  );
  const revision = (await built.customProviders.statuses())[0]!.revision;
  const queued = await built.app.turn({
    surface: "dingtalk",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "dingtalk:alice:custom-provider-bound" },
    text: "hello",
    model: "dingtalk-model",
    async: true,
  });
  assert.equal(queued.status, "queued");
  if (queued.status !== "queued") return;
  assert.ok(queued.runId);
  const run = await built.runs.get(queued.runId);
  assert.equal(run?.request.modelProviderId, "dingtalk-gateway");
  assert.equal(run?.request.modelProviderRevision, revision);
});

test("non-Web orphaned steers cannot switch custom Providers during replay", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-steer-bound-")) }));
  await built.customProviders.upsert(
    {
      id: "provider-a",
      name: "Provider A",
      protocol: "openai",
      baseUrl: "https://provider-a.example.com/v1",
      models: [{ id: "shared-model" }],
    },
    "sk-provider-a",
    "admin-alice@default-org",
  );
  const first = await built.app.turn({
    surface: "dingtalk",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "dingtalk:alice:provider-steer" },
    text: "first",
    model: "shared-model",
    liveActor: true,
    async: true,
  });
  assert.equal(first.status, "queued");
  if (first.status !== "queued" || !first.runId) return;
  const second = await built.app.turn({
    surface: "dingtalk",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "dingtalk:alice:provider-steer" },
    text: "second",
    model: "shared-model",
    liveActor: true,
    async: true,
  });
  assert.equal(second.status, "queued");
  assert.equal(second.steered, true);
  const [signal] = await built.signals.takePending(first.runId);
  assert.equal(signal?.request?.modelProviderId, "provider-a");
  assert.equal(signal?.request?.modelProviderRevision, 1);
  await built.signals.send(first.runId, signal!);
  await built.customProviders.delete("provider-a", "admin-alice@default-org");
  await built.customProviders.upsert(
    {
      id: "provider-b",
      name: "Provider B",
      protocol: "openai",
      baseUrl: "https://provider-b.example.com/v1",
      models: [{ id: "shared-model" }],
    },
    "sk-provider-b",
    "admin-alice@default-org",
  );
  assert.equal(await built.runs.withdraw(first.runId), true);
  await built.app.replayOrphanedRunSignals(first.runId);
  const runs = await built.runs.list();
  assert.equal(runs.length, 0);
  assert.equal(await built.runs.activeForThread("dingtalk:alice:provider-steer"), null);
});
