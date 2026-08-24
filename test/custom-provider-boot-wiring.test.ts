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
