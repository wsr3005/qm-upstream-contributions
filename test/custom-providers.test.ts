import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setCustomProviders,
  resolveCustomModel,
  isCustomModelId,
  customModelCatalog,
  customProvidersVersion,
  validateCustomProviderSpec,
} from "../src/model/custom-providers.ts";
import { builtInModelCatalog } from "../src/model/model-catalog.ts";
import { createCustomProviderStore } from "../src/model/custom-provider-store.ts";
import {
  modelSupportedByHarness,
  modelServiceable,
  registerOpenRouterCatalogModel,
  resolveModel,
  resolveStaticModel,
} from "../src/model/pi-models.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { StoredCustomProvider } from "../src/model/custom-provider-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

afterEach(() => setCustomProviders([], []));

const GATEWAY = {
  id: "acme-gateway",
  name: "Acme Gateway",
  protocol: "openai" as const,
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large", name: "Acme Large", contextWindow: 200_000, maxTokens: 16_000, input: 2, output: 8 }],
};

test("a registered custom model resolves with the provider's protocol and base URL", () => {
  setCustomProviders([GATEWAY]);
  const model = resolveCustomModel("acme-large");
  assert.ok(model);
  assert.equal(model.provider, "acme-gateway");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://llm.acme.internal/v1");
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.cost.input, 2);
});

test("anthropic-protocol providers produce anthropic-messages models with defaults", () => {
  setCustomProviders([
    {
      id: "eu-anthropic",
      name: "EU Anthropic-compatible",
      protocol: "anthropic",
      baseUrl: "https://eu.example.com",
      models: [{ id: "eu-claude" }],
    },
  ]);
  const model = resolveCustomModel("eu-claude");
  assert.ok(model);
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.cost.input, 0);
});

test("OpenAI Responses providers are available to all three enterprise harnesses", () => {
  setCustomProviders([
    {
      ...GATEWAY,
      protocol: "openai-responses",
      models: [{ id: "responses-model" }],
    },
  ]);
  assert.equal(resolveCustomModel("responses-model")?.api, "openai-responses");
  assert.equal(modelSupportedByHarness("responses-model", "pi"), true);
  assert.equal(modelSupportedByHarness("responses-model", "opencode"), true);
  assert.equal(modelSupportedByHarness("responses-model", "codex"), true);
});

test("a custom selection alias resolves to its upstream wire model id", () => {
  setCustomProviders([
    {
      ...GATEWAY,
      protocol: "openai-responses",
      models: [{ id: "gateway/gpt-5.6-luna", upstreamId: "gpt-5.6-luna", name: "GPT 5.6 Luna" }],
    },
  ]);
  const selected = resolveCustomModel("gateway/gpt-5.6-luna");
  assert.equal(selected?.id, "gateway/gpt-5.6-luna");
  assert.equal(selected?.wireId, "gpt-5.6-luna");
  assert.equal(resolveModel("gateway/gpt-5.6-luna")?.provider, "acme-gateway");
});

test("resolveModel falls back to custom models; built-ins shadow custom ids", () => {
  setCustomProviders([{ ...GATEWAY, models: [{ id: "acme-large" }, { id: "claude-opus-5", name: "impostor" }] }]);
  assert.equal(resolveModel("acme-large")?.provider, "acme-gateway");
  // The built-in claude-opus-5 must win over a custom model claiming its id.
  assert.equal(String(resolveModel("claude-opus-5")?.provider), "anthropic");
});

test("custom model source binding survives dynamic arrival order and removal", () => {
  const lateId = "vendor/future-model-late";
  setCustomProviders([{ ...GATEWAY, models: [{ id: lateId, name: "Private Late" }] }]);
  assert.equal(resolveModel(lateId)?.provider, GATEWAY.id);
  registerOpenRouterCatalogModel({
    id: lateId,
    name: "Public Late",
    contextWindow: 128_000,
    maxTokens: 8_192,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0 },
  });
  assert.equal(resolveStaticModel(lateId), undefined);
  assert.equal(resolveModel(lateId)?.provider, GATEWAY.id);

  const earlyId = "vendor/future-model-early";
  registerOpenRouterCatalogModel({
    id: earlyId,
    name: "Public Early",
    contextWindow: 128_000,
    maxTokens: 8_192,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0 },
  });
  assert.equal(resolveModel(earlyId)?.provider, "openrouter");
  setCustomProviders([{ ...GATEWAY, models: [{ id: earlyId, name: "Private Early" }] }]);
  assert.equal(resolveModel(earlyId)?.provider, GATEWAY.id);
  setCustomProviders([]);
  assert.equal(resolveModel(earlyId), undefined);
  setCustomProviders([], [earlyId]);
  assert.equal(resolveModel(earlyId), undefined);
});

test("custom models are gated to pi and mock harnesses", () => {
  setCustomProviders([GATEWAY]);
  assert.equal(modelSupportedByHarness("acme-large", "pi"), true);
  assert.equal(modelSupportedByHarness("acme-large", "mock"), true);
  assert.equal(modelSupportedByHarness("acme-large", "claude"), false);
  assert.equal(modelSupportedByHarness("acme-large", "codex"), false);
  assert.equal(modelSupportedByHarness("acme-large", "opencode"), true);
});

test("a registered custom model is serviceable regardless of built-in key availability", () => {
  setCustomProviders([GATEWAY]);
  assert.equal(modelServiceable("acme-large", { anthropic: false, openai: false, openrouter: false }), true);
});

test("catalog lists custom models; clearing the registry removes them", () => {
  setCustomProviders([GATEWAY]);
  assert.deepEqual(customModelCatalog(), [{ id: "acme-large", name: "Acme Large", provider: "acme-gateway" }]);
  setCustomProviders([]);
  assert.equal(isCustomModelId("acme-large"), false);
  assert.equal(resolveModel("acme-large"), undefined);
});

test("spec validation rejects reserved ids, bad slugs, bad URLs, and empty model lists", () => {
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "openai" }), /reserved/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, id: "Not A Slug" }), /slug/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, baseUrl: "ftp://x" }), /http/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, baseUrl: "https://x?y=1" }), /query/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, models: [] }), /at least one model/);
  assert.throws(() => validateCustomProviderSpec({ ...GATEWAY, models: [{ id: "a" }, { id: "a" }] }), /duplicate/);
  assert.throws(
    () => validateCustomProviderSpec({ ...GATEWAY, models: [{ id: "a", contextWindow: 0 }] }),
    /positive integer/,
  );
  assert.throws(
    () => validateCustomProviderSpec({ ...GATEWAY, models: [{ id: "a", maxTokens: 1.5 }] }),
    /positive integer/,
  );
  assert.doesNotThrow(() => validateCustomProviderSpec({ ...GATEWAY, models: [{ id: "a", input: 0, output: 0.5 }] }));
});

test("spec validation rejects malformed model entries and upstream ids", () => {
  assert.throws(
    () => validateCustomProviderSpec({ ...GATEWAY, models: [null as unknown as { id: string }] }),
    /every model needs an id/,
  );
  assert.throws(
    () =>
      validateCustomProviderSpec({
        ...GATEWAY,
        models: [{ id: "gateway-model", upstreamId: 42 as unknown as string }],
      }),
    /upstreamId must be a non-empty string/,
  );
  assert.throws(
    () =>
      validateCustomProviderSpec({
        ...GATEWAY,
        models: [{ id: "gateway-model", upstreamId: " gpt-5.6-luna " }],
      }),
    /upstreamId must be a non-empty string/,
  );
});

test("store round-trip: upsert encrypts the key, statuses never leak it, delete disables", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "test-key-material" });

  await store.upsert(GATEWAY, "sk-secret-123", "admin@example.com");
  const statuses = await store.statuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.hasKey, true);
  assert.equal(JSON.stringify(statuses).includes("sk-secret-123"), false);

  const raw = await backing.get("acme-gateway");
  assert.ok(raw?.apiKeyEnc);
  assert.equal(raw!.apiKeyEnc!.includes("sk-secret-123"), false);
  assert.equal(raw?.revision, 1);

  assert.equal(await store.resolveKey("acme-gateway"), "sk-secret-123");
  assert.deepEqual(await store.enabled(), [GATEWAY]);

  // Upsert without a key keeps the existing one.
  await store.upsert({ ...GATEWAY, name: "Renamed" }, undefined, "admin@example.com");
  assert.equal(await store.resolveKey("acme-gateway"), "sk-secret-123");
  assert.equal((await store.resolveActive("acme-gateway"))?.revision, 2);

  assert.equal(await store.delete("acme-gateway", "admin@example.com"), true);
  assert.equal(await store.resolveKey("acme-gateway"), null);
  assert.deepEqual(await store.enabled(), []);
  assert.equal((await store.statuses())[0]!.disabled, true);
  assert.equal((await backing.get("acme-gateway"))?.revision, 3);
  assert.equal(await store.delete("never-existed", "admin@example.com"), false);
});

test("store validates specs on upsert", async () => {
  const store = createCustomProviderStore({
    backing: createMemoryMap<StoredCustomProvider>(),
    keyMaterial: "k",
  });
  await assert.rejects(store.upsert({ ...GATEWAY, id: "anthropic" }, "k", "a@b.c"), /reserved/);
});

test("wire-id providers stay legacy-disabled and activate only when every live runtime is compatible", async () => {
  let ready = false;
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({
    backing,
    keyMaterial: "wire-id-key-material",
    runtimeSchemaReady: async () => ready,
  });
  const aliased = {
    ...GATEWAY,
    protocol: "openai-responses" as const,
    models: [{ id: "acme/gpt-luna", upstreamId: "gpt-5.6-luna" }],
  };

  await assert.rejects(store.upsert(aliased, "sk-alias", "admin@example.com"), /compatibility rollout/);
  ready = true;
  await store.upsert(aliased, "sk-alias", "admin@example.com");
  const raw = await backing.get(GATEWAY.id);
  assert.equal(raw?.disabled, true);
  assert.equal(raw?.compatibilityDisabled, true);
  assert.equal(raw?.runtimeSchema, 1);
  assert.deepEqual(await store.enabled(), [aliased]);
  assert.equal((await store.statuses())[0]?.disabled, false);

  ready = false;
  assert.deepEqual(await store.enabled(), []);
  assert.equal(await store.resolveActive(GATEWAY.id), null);
  assert.equal((await store.statuses())[0]?.disabled, true);

  ready = true;
  assert.equal(await store.delete(GATEWAY.id, "admin@example.com"), true);
  assert.deepEqual(await store.enabled(), []);
  const deleted = await backing.get(GATEWAY.id);
  assert.equal(deleted?.disabled, true);
  assert.equal(deleted?.compatibilityDisabled, false);
});

test("compatibility runtime reads wire-id records while production writes stay closed", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({
    backing,
    keyMaterial: "compatibility-release-key",
    runtimeSchemaReady: async () => true,
    runtimeSchemaWritable: async () => false,
  });
  const aliased = {
    ...GATEWAY,
    protocol: "openai-responses" as const,
    models: [{ id: "acme/gpt-luna", upstreamId: "gpt-5.6-luna" }],
  };

  await backing.put(GATEWAY.id, {
    ...aliased,
    disabled: true,
    compatibilityDisabled: true,
    runtimeSchema: 1,
    updatedAt: Date.now(),
    updatedBy: "newer-release",
  });

  assert.deepEqual(await store.enabled(), [aliased]);
  const before = await backing.get(GATEWAY.id);
  await assert.rejects(store.upsert(aliased, "sk-alias", "admin@example.com"), /compatibility rollout/);
  await assert.rejects(
    store.upsert(
      { ...GATEWAY, protocol: "openai-responses", models: [{ id: "acme/gpt-luna" }] },
      "sk-legacy-edit",
      "admin@example.com",
    ),
    /compatibility rollout/,
  );
  assert.deepEqual(await backing.get(GATEWAY.id), before);
});

test("concurrent provider writes cannot claim the same model id", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const advisoryLock = createMemoryAdvisoryLock();
  const first = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  const second = createCustomProviderStore({ backing, keyMaterial: "k", advisoryLock });
  const results = await Promise.allSettled([
    first.upsert({ ...GATEWAY, id: "first-gateway" }, "sk-first", "admin@example.com"),
    second.upsert({ ...GATEWAY, id: "second-gateway" }, "sk-second", "admin@example.com"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await first.enabled()).length, 1);
});

test("an unchanged custom provider snapshot does not invalidate runtime caches", () => {
  setCustomProviders([GATEWAY]);
  const version = customProvidersVersion();
  setCustomProviders([{ ...GATEWAY, models: [...GATEWAY.models] }]);
  assert.equal(customProvidersVersion(), version);
});

test("provider model history preserves removed custom identities", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({
    backing,
    keyMaterial: "history-key-material",
    advisoryLock: createMemoryAdvisoryLock(),
  });
  await store.upsert({ ...GATEWAY, models: [{ id: "gpt-private" }] }, "sk-private", "admin@example.com");
  await store.upsert({ ...GATEWAY, models: [{ id: "replacement-model" }] }, undefined, "admin@example.com");
  assert.equal(await store.knowsModel("gpt-private"), true);
  assert.equal(await store.knowsModel("replacement-model"), true);
  assert.equal(await store.knowsModel("gpt-future-native"), false);
  await store.delete(GATEWAY.id, "admin@example.com");
  const restarted = createCustomProviderStore({ backing, keyMaterial: "history-key-material" });
  assert.deepEqual((await restarted.knownModelIds()).sort(), ["gpt-private", "replacement-model"]);
  registerOpenRouterCatalogModel({
    id: "gpt-private",
    name: "Public Impostor",
    contextWindow: 128_000,
    maxTokens: 8_192,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0 },
  });
  setCustomProviders(await restarted.enabled(), await restarted.knownModelIds());
  assert.equal(resolveModel("gpt-private"), undefined);
});

test("active provider resolution keeps the endpoint and key from one durable snapshot", async () => {
  const inner = createMemoryMap<StoredCustomProvider>();
  const seed = createCustomProviderStore({ backing: inner, keyMaterial: "snapshot-key-material" });
  await seed.upsert(GATEWAY, "sk-old", "admin@example.com");
  const oldRecord = await inner.get(GATEWAY.id);
  await seed.upsert({ ...GATEWAY, baseUrl: "https://new.example.com/v1" }, "sk-new", "admin@example.com");
  const newRecord = await inner.get(GATEWAY.id);
  assert.ok(oldRecord && newRecord);
  await inner.put(GATEWAY.id, oldRecord);
  let reads = 0;
  const backing = {
    ...inner,
    async get(id: string) {
      reads += 1;
      const value = await inner.get(id);
      await inner.put(id, newRecord);
      return value;
    },
  };
  const store = createCustomProviderStore({ backing, keyMaterial: "snapshot-key-material" });
  const active = await store.resolveActive(GATEWAY.id);
  assert.equal(reads, 1);
  assert.equal(active?.provider.baseUrl, GATEWAY.baseUrl);
  assert.equal(active?.apiKey, "sk-old");
});

test("registered models surface in the catalog and vanish on unregister", () => {
  setCustomProviders([
    {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    },
  ]);
  const catalog = builtInModelCatalog();
  const entry = catalog.find((m) => m.id === "deepseek-chat");
  assert.ok(entry, "custom model appears in the catalog");
  assert.equal(entry!.provider, "deepseek");
  setCustomProviders([]);
  assert.ok(!builtInModelCatalog().some((m) => m.id === "deepseek-chat"));
});

test("opencode modelRef routes slashed custom model ids to the registered provider, not a phantom slash-prefix", async () => {
  const { modelRef } = await import("../src/harness/opencode-harness.ts");
  setCustomProviders([
    {
      id: "litellm",
      name: "LiteLLM",
      protocol: "openai",
      baseUrl: "https://litellm.example.com/v1",
      models: [{ id: "bedrock/claude-opus-5" }, { id: "litellm/gpt-luna", upstreamId: "gpt-5.6-luna" }],
    },
  ]);
  try {
    assert.deepEqual(modelRef("bedrock/claude-opus-5"), { providerID: "litellm", modelID: "bedrock/claude-opus-5" });
    assert.deepEqual(modelRef("litellm/gpt-luna"), { providerID: "litellm", modelID: "gpt-5.6-luna" });
    // built-in slash convention untouched
    assert.deepEqual(modelRef("openrouter/auto"), { providerID: "openrouter", modelID: "auto" });
  } finally {
    setCustomProviders([]);
  }
});

test("catalog cache invalidates immediately when the custom registry changes", async () => {
  const { selectableModelCatalog } = await import("../src/model/model-catalog.ts");
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  setCustomProviders([]);
  const before = await selectableModelCatalog(fetcher);
  assert.ok(!before.some((m) => m.id === "fresh-model"));
  setCustomProviders([
    {
      id: "freshco",
      name: "FreshCo",
      protocol: "openai",
      baseUrl: "https://fresh.example.com/v1",
      models: [{ id: "fresh-model" }],
    },
  ]);
  try {
    const after = await selectableModelCatalog(fetcher);
    assert.ok(
      after.some((m) => m.id === "fresh-model"),
      "new registration visible without waiting out the TTL",
    );
  } finally {
    setCustomProviders([]);
  }
  const cleared = await selectableModelCatalog(fetcher);
  assert.ok(!cleared.some((m) => m.id === "fresh-model"), "removal visible immediately too");
});
