import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { defaultModelForHarness, isHarnessId, modelSupportedByHarness, type HarnessId } from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import type {
  Harness,
  HarnessSecurityScreenInput,
  HarnessTitleInput,
  HarnessTurnInput,
  HarnessTurnResult,
} from "./harness.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";

export interface RuntimeChoice {
  harnessId: HarnessId;
  modelId: string;
}

type RuntimeInput = Pick<
  HarnessTurnInput,
  "scopeLabel" | "harness" | "model" | "modelProviderId" | "modelProviderRevision"
>;

type RuntimeExecution = <T>(
  input: RuntimeInput & { runtimeOperation: "turn" | "title" | "security-screen" },
  choice: RuntimeChoice,
  execute: () => Promise<T>,
) => Promise<T>;

export function resolveRuntimeChoice(
  config: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel">,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
): RuntimeChoice {
  const approved = config.getApprovedHarnesses() ?? [fallback.harnessId];
  const orgStored = config.getRuntimeSelection(orgScopeId);
  const orgLegacy = config.getBaseModel(orgScopeId);
  const configuredOrg =
    orgStored && isHarnessId(orgStored.harnessId)
      ? { harnessId: orgStored.harnessId, modelId: orgStored.modelId }
      : { harnessId: fallback.harnessId, modelId: orgLegacy ?? fallback.modelId };
  const firstApproved = approved.find(isHarnessId) ?? fallback.harnessId;
  const safeFallback =
    approved.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? fallback
      : { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) };
  if (
    (orgStored || orgLegacy) &&
    (!approved.includes(configuredOrg.harnessId) ||
      !modelSupportedByHarness(configuredOrg.modelId, configuredOrg.harnessId))
  ) {
    throw new NonRetryableTurnError(
      `configured runtime ${configuredOrg.harnessId}/${configuredOrg.modelId} is unavailable`,
    );
  }
  const org =
    approved.includes(configuredOrg.harnessId) &&
    modelSupportedByHarness(configuredOrg.modelId, configuredOrg.harnessId)
      ? configuredOrg
      : safeFallback;
  const scopedStored = scope === orgScopeId ? null : config.getRuntimeSelection(scope);
  const scopedLegacy = scope === orgScopeId ? null : config.getBaseModel(scope);
  let inherited = org;
  if (scopedStored && isHarnessId(scopedStored.harnessId)) {
    inherited = { harnessId: scopedStored.harnessId, modelId: scopedStored.modelId };
  } else if (scopedLegacy) {
    inherited = { harnessId: fallback.harnessId, modelId: scopedLegacy };
  }
  if (
    (scopedStored || scopedLegacy) &&
    (!approved.includes(inherited.harnessId) || !modelSupportedByHarness(inherited.modelId, inherited.harnessId))
  ) {
    throw new NonRetryableTurnError(`configured runtime ${inherited.harnessId}/${inherited.modelId} is unavailable`);
  }
  const choice =
    requested?.harnessId || requested?.modelId
      ? { harnessId: requested.harnessId ?? inherited.harnessId, modelId: requested.modelId ?? inherited.modelId }
      : inherited;
  if (!approved.includes(choice.harnessId) || !modelSupportedByHarness(choice.modelId, choice.harnessId)) {
    if (requested?.harnessId || requested?.modelId)
      throw new NonRetryableTurnError(`runtime ${choice.harnessId}/${choice.modelId} is not approved`);
    return org;
  }
  return choice;
}

export async function resolveRuntimeChoiceDurable(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
): Promise<RuntimeChoice> {
  const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
  const [orgStored, scopedStored, orgLegacy, scopedLegacy] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    config.getBaseModelOwnDurable(orgScopeId),
    scope === orgScopeId ? null : config.getBaseModelOwnDurable(scope),
  ]);
  const view: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel"> = {
    getApprovedHarnesses: () => approved,
    getRuntimeSelection: (id: ScopeId) => {
      if (id === orgScopeId) return orgStored;
      return id === scope ? scopedStored : null;
    },
    getBaseModel: (id: ScopeId) => {
      if (id === orgScopeId) return orgLegacy;
      return id === scope ? scopedLegacy : null;
    },
  };
  return resolveRuntimeChoice(view, orgScopeId, scope, fallback, requested);
}

export function createHarnessRouter(
  adapters: ReadonlyMap<HarnessId, Harness>,
  utility: Harness,
  resolve: (input: RuntimeInput) => RuntimeChoice | Promise<RuntimeChoice>,
  runWithChoice?: RuntimeExecution,
): Harness {
  const lastHarness = new Map<string, HarnessId>();
  return {
    profile: utility.profile,
    models: {
      ...utility.models,
      screenSecurity: async (input: HarnessSecurityScreenInput) => {
        const choice = await resolve(input);
        const adapter = adapters.get(choice.harnessId);
        if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
        const execute = async () =>
          adapter.models.screenSecurity?.({ ...input, harness: choice.harnessId, model: choice.modelId });
        return runWithChoice && !input.providerFenceAlreadyHeld
          ? runWithChoice({ ...input, runtimeOperation: "security-screen" }, choice, execute)
          : execute();
      },
      generateTitle: async (input: HarnessTitleInput) => {
        const choice = await resolve(input);
        const adapter = adapters.get(choice.harnessId);
        if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
        const execute = async () =>
          adapter.models.generateTitle?.({ ...input, harness: choice.harnessId, model: choice.modelId });
        return runWithChoice ? runWithChoice({ ...input, runtimeOperation: "title" }, choice, execute) : execute();
      },
    },
    tools: utility.tools,
    turns: {
      async runTurn(input) {
        const choice = await resolve(input);
        const adapter = adapters.get(choice.harnessId);
        if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
        const execute = async (): Promise<HarnessTurnResult> => {
          const prior = lastHarness.get(input.session.id);
          if (prior && prior !== choice.harnessId) {
            await adapters.get(prior)?.turns.resetSession?.(input.session.id);
            await adapter.turns.resetSession?.(input.session.id);
          }
          lastHarness.set(input.session.id, choice.harnessId);
          const runtime = {
            harness: choice.harnessId,
            model: choice.modelId,
            ...(input.modelProviderId ? { modelProviderId: input.modelProviderId } : {}),
            ...(input.modelProviderRevision !== undefined
              ? { modelProviderRevision: input.modelProviderRevision }
              : {}),
            providerFenceAlreadyHeld: true as const,
          };
          return adapter.turns.runTurn({
            ...input,
            harness: choice.harnessId,
            model: choice.modelId,
            ...(input.screenToolResult
              ? {
                  screenToolResult: (tool, result, unscreenable) =>
                    input.screenToolResult!(tool, result, unscreenable, runtime),
                }
              : {}),
            ...(input.screenExternalContent
              ? {
                  screenExternalContent: (external) => input.screenExternalContent!(external, runtime),
                }
              : {}),
          });
        };
        return runWithChoice ? runWithChoice({ ...input, runtimeOperation: "turn" }, choice, execute) : execute();
      },
      async resetSession(sessionId) {
        lastHarness.delete(sessionId);
        await Promise.all([...adapters.values()].map((adapter) => adapter.turns.resetSession?.(sessionId)));
      },
      async close() {
        await Promise.all([...new Set(adapters.values())].map((adapter) => adapter.turns.close?.()));
      },
    },
  };
}
