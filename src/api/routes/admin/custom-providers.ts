import {
  CUSTOM_PROVIDER_PROTOCOLS,
  runtimeModelForCustomProvider,
  validateCustomProviderSpec,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import {
  CUSTOM_PROVIDER_WIRE_ID_SCHEMA,
  CustomProviderRuntimeNotReadyError,
} from "../../../model/custom-provider-store.ts";
import { modelSupportedByHarness, resolveModel, resolveStaticModel } from "../../../model/pi-models.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import {
  CustomProviderHarnessTestRolloutIncompleteError,
  CustomProviderTestConfigurationChangedError,
  type CustomProviderTestHarness,
} from "../../deps.ts";

const TEST_HARNESSES = new Set<CustomProviderTestHarness>(["pi", "opencode", "codex"]);

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

/**
 * Key validation against the registered endpoint, protocol-appropriate.
 * A gateway may not implement a models listing, so callers can skip
 * with {"validate": false} — the registration is admin-only either way.
 */
async function validateKey(
  ctx: ApiCtx,
  protocol: CustomProviderProtocol,
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  const url = protocol === "anthropic" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
  const headers: Record<string, string> =
    protocol === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
  try {
    const response = await (ctx.deps.modelCredentialFetch ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getCustomProviders(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.read",
    resource: "custom-providers",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { providers: await ctx.deps.customProviders.statuses() });
}

export async function putCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "a JSON object is required" });
  }
  const body = ctx.body as {
    name?: unknown;
    protocol?: unknown;
    baseUrl?: unknown;
    models?: unknown;
    apiKey?: unknown;
    validate?: unknown;
  };
  if (typeof body.name !== "string" || typeof body.protocol !== "string" || typeof body.baseUrl !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "name, protocol, and baseUrl are required" });
  }
  if (!(CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(body.protocol)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `protocol must be one of ${CUSTOM_PROVIDER_PROTOCOLS.join(", ")}`,
    });
  }
  const submittedModels = Array.isArray(body.models) ? (body.models as CustomProviderSpec["models"]) : [];
  const spec: CustomProviderSpec = {
    id,
    name: body.name,
    protocol: body.protocol as CustomProviderProtocol,
    baseUrl: body.baseUrl.trim().replace(/\/+$/, ""),
    models: submittedModels.map((model) =>
      typeof model?.id === "string" && resolveStaticModel(model.id)
        ? { ...model, id: `${id}/${model.id}`, upstreamId: model.upstreamId ?? model.id }
        : model,
    ),
  };
  try {
    validateCustomProviderSpec(spec);
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
  }
  if (
    spec.models.some((model) => model.upstreamId !== undefined) &&
    !(await ctx.deps.customProviders.runtimeSchemaWritable(CUSTOM_PROVIDER_WIRE_ID_SCHEMA))
  ) {
    return sendJson(ctx.res, 409, {
      error: "runtime_rollout_incomplete",
      message: "custom model aliases are unavailable until the compatibility rollout is complete",
    });
  }
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
  const shouldValidate = body.validate !== false && apiKey !== undefined;
  if (shouldValidate && !(await validateKey(ctx, spec.protocol, spec.baseUrl, apiKey!))) {
    return sendJson(ctx.res, 400, {
      error: "invalid_api_key",
      message: `${spec.baseUrl} rejected this API key (pass "validate": false to skip for endpoints without a models listing)`,
    });
  }
  try {
    await ctx.deps.customProviders.upsert(spec, apiKey, authorized.id);
  } catch (e) {
    const rollout = e instanceof CustomProviderRuntimeNotReadyError;
    return sendJson(ctx.res, rollout ? 409 : 400, {
      error: rollout ? "runtime_rollout_incomplete" : "bad_request",
      message: (e as Error).message,
    });
  }
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  const status = (await ctx.deps.customProviders.statuses()).find((item) => item.id === id);
  return sendJson(ctx.res, 200, { ok: true, status });
}

export async function testCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "a JSON object is required" });
  }
  const body = ctx.body as { modelId?: unknown; harness?: unknown };
  if (typeof body.modelId !== "string" || !body.modelId.trim()) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "modelId is required" });
  }
  const modelId = body.modelId.trim();
  const harnessId = body.harness === undefined ? "pi" : body.harness;
  if (typeof harnessId !== "string" || !TEST_HARNESSES.has(harnessId as CustomProviderTestHarness)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "harness must be one of pi, opencode, or codex",
    });
  }
  const readRolloutFence = ctx.deps.customProviderHarnessTestFence ?? (async () => null);
  const initialState = await ctx.deps.customProviders.harnessTestState(id, readRolloutFence).catch(() => null);
  if (!initialState) {
    return sendJson(ctx.res, 502, { error: "provider_test_failed", message: "the saved test state could not be read" });
  }
  const rolloutFence = initialState.rolloutFence;
  if (!rolloutFence) {
    return sendJson(ctx.res, 409, {
      error: "harness_test_rollout_incomplete",
      message: "model testing is unavailable until every live QM runtime supports this test version",
    });
  }
  const active = initialState.active;
  if (!active) return sendJson(ctx.res, 404, { error: "not_found" });
  const { provider, apiKey, revision } = active;
  if (!provider.models.some((model) => model.id === modelId)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `model "${modelId}" is not registered to ${id}` });
  }
  if (!apiKey) {
    return sendJson(ctx.res, 400, { error: "missing_api_key", message: "this provider has no active API key" });
  }
  const model = runtimeModelForCustomProvider(provider, modelId);
  if (!model) return sendJson(ctx.res, 409, { error: "provider_not_ready", message: "the saved model is not active" });
  await ctx.deps.refreshCustomProviders?.();
  const resolved = resolveModel(modelId);
  if (
    !resolved ||
    resolved.provider !== model.provider ||
    resolved.api !== model.api ||
    resolved.baseUrl !== model.baseUrl
  ) {
    return sendJson(ctx.res, 409, {
      error: "provider_not_ready",
      message: "the saved model is shadowed or the runtime has not activated this provider version",
    });
  }
  if (!modelSupportedByHarness(modelId, harnessId)) {
    return sendJson(ctx.res, 400, {
      error: "harness_not_supported",
      message: `${harnessId} does not support this provider protocol`,
    });
  }
  if (!ctx.deps.customProviderHarnessTest) {
    return sendJson(ctx.res, 503, {
      error: "harness_test_unavailable",
      message: "model testing is unavailable on this QM runtime",
    });
  }
  const testHarness = harnessId as CustomProviderTestHarness;
  const upstreamModelId = model.id;
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.test",
    resource: `${id}/${modelId}/${testHarness}`,
    scopeLabel: orgScope(ctx.deps),
    status: "attempted",
    detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision}`,
  });
  const startedAt = Date.now();
  const recordResult = (
    status: "succeeded" | "failed",
    identity: { upstreamModelId: string; providerRevision: number } = { upstreamModelId, providerRevision: revision },
  ) =>
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status,
      detail: `harness=${testHarness} upstreamModelId=${identity.upstreamModelId} providerRevision=${identity.providerRevision} latencyMs=${Date.now() - startedAt}`,
    });
  try {
    const result = await ctx.deps.customProviderHarnessTest({
      providerId: id,
      modelId,
      harnessId: testHarness,
      expectedRevision: revision,
      rolloutFence,
      signal: AbortSignal.timeout(60_000),
    });
    const finalState = await ctx.deps.customProviders.harnessTestState(id, readRolloutFence);
    if (finalState.rolloutFence !== rolloutFence) {
      throw new CustomProviderHarnessTestRolloutIncompleteError(
        "custom provider harness testing became unavailable during the request",
      );
    }
    if (!finalState.active || finalState.active.revision !== revision || result.providerRevision !== revision) {
      throw new CustomProviderTestConfigurationChangedError("custom provider changed during the test");
    }
    const identity = {
      upstreamModelId: result.upstreamModelId,
      providerRevision: result.providerRevision,
    };
    const reply = result.reply;
    if (!reply?.trim()) {
      recordResult("failed", identity);
      return sendJson(ctx.res, 502, { error: "provider_test_failed", message: "the model returned no text" });
    }
    recordResult("succeeded", identity);
    return sendJson(ctx.res, 200, {
      ok: true,
      providerId: id,
      modelId,
      upstreamModelId: result.upstreamModelId,
      harness: testHarness,
      reply: reply.trim(),
      latencyMs: Date.now() - startedAt,
      ...(result.maxOutputTokens !== undefined ? { maxOutputTokens: result.maxOutputTokens } : {}),
    });
  } catch (error) {
    recordResult("failed");
    if (error instanceof CustomProviderHarnessTestRolloutIncompleteError) {
      return sendJson(ctx.res, 409, {
        error: "harness_test_rollout_incomplete",
        message: "model testing became unavailable during a mixed-version rollout; retry after rollout completes",
      });
    }
    if (error instanceof CustomProviderTestConfigurationChangedError) {
      return sendJson(ctx.res, 409, {
        error: "provider_changed_during_test",
        message: "the provider configuration changed during the test; retry to verify the current version",
      });
    }
    return sendJson(ctx.res, 502, {
      error: "provider_test_failed",
      message: `${testHarness} could not complete the saved model request`,
    });
  }
}

export async function deleteCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const removed = await ctx.deps.customProviders.delete(id, authorized.id);
  if (!removed) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
