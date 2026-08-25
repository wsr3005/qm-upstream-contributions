import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryConfigStore,
  type PersistedApprovedHarnesses,
  type PersistedBaseModel,
} from "../src/resolution/config-store.ts";
import {
  createHarnessRouter,
  resolveRuntimeChoice,
  resolveRuntimeChoiceDurable,
} from "../src/harness/harness-router.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { Harness, HarnessTitleInput, HarnessTurnInput } from "../src/harness/harness.ts";

const ORG = "org:default-org" as const;
const PERSONAL = "personal:alice" as const;

test("runtime selection is sparse, revisioned, and acknowledges a changed org default", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  config.setRuntimeSelection(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  await config.flushScope(ORG);
  await config.flushScope(PERSONAL);

  assert.equal(config.getRuntimeSelection(ORG)?.revision, 1);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  assert.equal(config.getRuntimeSelection(ORG)?.revision, 2);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  config.acknowledgeRuntimeSelection(PERSONAL);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 2);

  config.setRuntimeSelection(PERSONAL, null);
  assert.equal(config.getRuntimeSelection(PERSONAL), null);
});

test("runtime resolution uses explicit choice, then scope, then org and rejects unapproved requests", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  config.setRuntimeSelection(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), { harnessId: "codex", modelId: "gpt-5.5" });
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-sonnet-4-6" }),
    { harnessId: "pi", modelId: "claude-sonnet-4-6" },
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "opencode", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("runtime resolution falls back to the first approved harness when deployment defaults are not approved", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["codex"]);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "claude-opus-4-8" }), {
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
  });
});

test("runtime resolution fails closed when a stored runtime is unavailable", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex"]);
  config.setRuntimeSelection(ORG, { harnessId: "codex", modelId: "removed-custom-model" });
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "claude-opus-4-8" }),
    /configured runtime codex\/removed-custom-model is unavailable/,
  );
});

test("runtime resolution reads approvals and selections from shared durable state on every turn", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const approvedHarnesses = createMemoryMap<PersistedApprovedHarnesses>();
  const writer = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const reader = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  writer.setApprovedHarnesses(["pi"]);
  await writer.setRuntimeSelectionLatest(ORG, fallback);
  await writer.flushScope(ORG);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), fallback);

  writer.setApprovedHarnesses(["codex"]);
  await writer.setRuntimeSelectionLatest(ORG, { harnessId: "codex", modelId: "gpt-5.5" });
  await writer.flushScope(ORG);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), {
    harnessId: "codex",
    modelId: "gpt-5.5",
  });
  await assert.rejects(
    resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("every write that changes a scope's served model notifies listeners", async () => {
  const config = createMemoryConfigStore("default-org");
  const seen: string[] = [];
  config.onRuntimeSelectionChanged((id) => seen.push(id));
  config.setApprovedHarnesses(["pi", "codex"]);

  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  await config.setRuntimeSelectionLatest(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  config.setBaseModel(PERSONAL, "gpt-5.6-sol");
  await config.setRuntimeSelectionLatest(PERSONAL, null);
  config.acknowledgeRuntimeSelection(PERSONAL);
  assert.deepEqual(seen, [ORG, PERSONAL, PERSONAL, PERSONAL]);
});

test("a listener that throws cannot break the write that notified it", async () => {
  const config = createMemoryConfigStore("default-org");
  config.onRuntimeSelectionChanged(() => {
    throw new Error("surface unreachable");
  });
  config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelectionLatest(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  assert.equal((await config.getRuntimeSelectionDurable(ORG))?.modelId, "claude-opus-4-8");
});

test("the routed turn guard encloses adapter execution", async () => {
  let guardActive = false;
  const adapter = {
    turns: {
      async runTurn() {
        assert.equal(guardActive, true);
        return { reply: "ok" };
      },
    },
  } as unknown as Harness;
  const router = createHarnessRouter(
    new Map([["pi", adapter]]),
    adapter,
    async () => ({ harnessId: "pi", modelId: "claude-opus-4-8" }),
    async (_input, _choice, execute) => {
      guardActive = true;
      try {
        return await execute();
      } finally {
        guardActive = false;
      }
    },
  );
  const result = await router.turns.runTurn({ session: { id: "guarded" } } as HarnessTurnInput);
  assert.equal(result.reply, "ok");
  assert.equal(guardActive, false);
});

test("title generation resolves the selected Harness and runs inside the same guard", async () => {
  let guardActive = false;
  const calls: Array<{ harness: string; model?: string; provider?: string; revision?: number }> = [];
  const adapter = (harness: string): Harness =>
    ({
      models: {
        async generateTitle(input) {
          assert.equal(guardActive, true);
          calls.push({
            harness,
            ...(input.model ? { model: input.model } : {}),
            ...(input.modelProviderId ? { provider: input.modelProviderId } : {}),
            ...(input.modelProviderRevision !== undefined ? { revision: input.modelProviderRevision } : {}),
          });
          return `${harness}:${input.model}`;
        },
      },
    }) as Harness;
  const adapters = new Map([
    ["pi", adapter("pi")],
    ["codex", adapter("codex")],
    ["opencode", adapter("opencode")],
  ] as const);
  const router = createHarnessRouter(
    adapters,
    adapters.get("pi")!,
    async (input) => ({
      harnessId: (input.harness ?? "pi") as "pi" | "codex" | "opencode",
      modelId: input.model ?? "org/default",
    }),
    async (input, choice, execute) => {
      assert.equal(input.modelProviderId, choice.modelId === "gateway/luna" ? "gateway" : undefined);
      guardActive = true;
      try {
        return await execute();
      } finally {
        guardActive = false;
      }
    },
  );

  const selected = await router.models.generateTitle!({
    transcript: "User:\nName this",
    scopeLabel: ORG,
    harness: "codex",
    model: "gateway/luna",
    modelProviderId: "gateway",
    modelProviderRevision: 7,
  });
  const inherited = await router.models.generateTitle!({ transcript: "User:\nName this", scopeLabel: ORG });

  assert.equal(selected, "codex:gateway/luna");
  assert.equal(inherited, "pi:org/default");
  assert.deepEqual(calls, [
    { harness: "codex", model: "gateway/luna", provider: "gateway", revision: 7 },
    { harness: "pi", model: "org/default" },
  ]);
  assert.equal(guardActive, false);
});

test("security screening resolves the selected Harness and Provider fence", async () => {
  let guardActive = false;
  const calls: Array<{ harness: string; model?: string; provider?: string; revision?: number }> = [];
  const adapter = (harness: string): Harness =>
    ({
      models: {
        async screenSecurity(input) {
          assert.equal(guardActive, true);
          calls.push({
            harness,
            ...(input.model ? { model: input.model } : {}),
            ...(input.modelProviderId ? { provider: input.modelProviderId } : {}),
            ...(input.modelProviderRevision !== undefined ? { revision: input.modelProviderRevision } : {}),
          });
          return { decision: "auto" };
        },
      },
    }) as Harness;
  const adapters = new Map([
    ["pi", adapter("pi")],
    ["opencode", adapter("opencode")],
    ["codex", adapter("codex")],
  ] as const);
  const router = createHarnessRouter(
    adapters,
    adapters.get("pi")!,
    async (input) => ({
      harnessId: (input.harness ?? "pi") as "pi" | "opencode" | "codex",
      modelId: input.model ?? "org/default",
    }),
    async (input, choice, execute) => {
      assert.equal(input.runtimeOperation, "security-screen");
      assert.equal(input.modelProviderId, choice.modelId === "gateway/luna" ? "gateway" : undefined);
      guardActive = true;
      try {
        return await execute();
      } finally {
        guardActive = false;
      }
    },
  );

  const verdict = await router.models.screenSecurity!({
    payload: "external content",
    signal: new AbortController().signal,
    scopeLabel: ORG,
    harness: "opencode",
    model: "gateway/luna",
    modelProviderId: "gateway",
    modelProviderRevision: 7,
    recordModelCall() {},
  });

  assert.deepEqual(verdict, { decision: "auto" });
  assert.deepEqual(calls, [{ harness: "opencode", model: "gateway/luna", provider: "gateway", revision: 7 }]);
  assert.equal(guardActive, false);
});

test("tool-result screening reuses its turn Provider fence without re-entering the guard", async () => {
  let guardActive = false;
  let guardCalls = 0;
  let screenCalls = 0;
  const adapter = {
    models: {
      async screenSecurity() {
        assert.equal(guardActive, true);
        screenCalls += 1;
        return { decision: "auto" as const };
      },
    },
    turns: {
      async runTurn(input: HarnessTurnInput) {
        assert.equal(guardActive, true);
        assert.equal(await input.screenToolResult!("read", "safe", false), true);
        assert.deepEqual(await input.screenExternalContent!({ content: "safe", tool: "read", source: "tool" }), {
          decision: "auto",
        });
        return { reply: "ok" };
      },
    },
  } as unknown as Harness;
  const router = createHarnessRouter(
    new Map([["pi", adapter]]),
    adapter,
    async () => ({ harnessId: "pi", modelId: "gateway/luna" }),
    async (_input, _choice, execute) => {
      guardCalls += 1;
      assert.equal(guardActive, false, "the Provider guard must not be re-entered");
      guardActive = true;
      try {
        return await execute();
      } finally {
        guardActive = false;
      }
    },
  );
  const classify = (runtime?: {
    harness: string;
    model: string;
    modelProviderId?: string;
    modelProviderRevision?: number;
    providerFenceAlreadyHeld: true;
  }) =>
    router.models.screenSecurity!({
      payload: "safe",
      signal: new AbortController().signal,
      scopeLabel: ORG,
      ...(runtime ?? {}),
      recordModelCall() {},
    });

  const result = await router.turns.runTurn({
    session: { id: "nested-screen" },
    scopeLabel: ORG,
    orgScopeId: ORG,
    modelProviderId: "gateway",
    modelProviderRevision: 7,
    screenToolResult: async (_tool, _result, _unscreenable, runtime) => (await classify(runtime))?.decision === "auto",
    screenExternalContent: async (_external, runtime) => classify(runtime),
  } as HarnessTurnInput);

  assert.equal(result.reply, "ok");
  assert.equal(screenCalls, 2);
  assert.equal(guardCalls, 1);
  assert.equal(guardActive, false);
});

test("an aborted title releases the shared execution guard for the next turn", async () => {
  const lock = createMemoryAdvisoryLock();
  const adapter = {
    models: {
      generateTitle: async (input: HarnessTitleInput) =>
        new Promise<undefined>((resolve) =>
          input.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
        ),
    },
    turns: {
      async runTurn() {
        return { reply: "next turn ran" };
      },
    },
  } as unknown as Harness;
  const router = createHarnessRouter(
    new Map([["pi", adapter]]),
    adapter,
    async () => ({ harnessId: "pi", modelId: "gateway/luna" }),
    async (_input, _choice, execute) => lock.withLock("custom-model-providers", execute),
  );

  await router.models.generateTitle!({
    transcript: "User:\nHang",
    scopeLabel: ORG,
    signal: AbortSignal.timeout(20),
  });
  const turn = await router.turns.runTurn({ session: { id: "after-title-timeout" } } as HarnessTurnInput);
  let providerWriteCompleted = false;
  await lock.withLock("custom-model-providers", async () => {
    providerWriteCompleted = true;
  });
  assert.equal(turn.reply, "next turn ran");
  assert.equal(providerWriteCompleted, true);
});
