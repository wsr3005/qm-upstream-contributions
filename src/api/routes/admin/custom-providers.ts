import {
  CUSTOM_PROVIDER_PROTOCOLS,
  runtimeModelForCustomProvider,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import { oneShot } from "../../../harness/pi-harness.ts";
import { resolveModel } from "../../../model/pi-models.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

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
  const spec: CustomProviderSpec = {
    id,
    name: body.name,
    protocol: body.protocol as CustomProviderProtocol,
    baseUrl: body.baseUrl.trim().replace(/\/+$/, ""),
    models: Array.isArray(body.models) ? (body.models as CustomProviderSpec["models"]) : [],
  };
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
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
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
  const body = ctx.body as { modelId?: unknown };
  if (typeof body.modelId !== "string" || !body.modelId.trim()) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "modelId is required" });
  }
  const modelId = body.modelId.trim();
  let active: { provider: CustomProviderSpec; apiKey: string | null } | null;
  try {
    active = await ctx.deps.customProviders.resolveActive(id);
  } catch {
    return sendJson(ctx.res, 502, { error: "provider_test_failed", message: "the saved provider could not be read" });
  }
  if (!active) return sendJson(ctx.res, 404, { error: "not_found" });
  const { provider, apiKey } = active;
  if (!provider.models.some((model) => model.id === modelId)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `model "${modelId}" is not registered to ${id}` });
  }
  if (!apiKey) {
    return sendJson(ctx.res, 400, { error: "missing_api_key", message: "this provider has no active API key" });
  }
  const model = runtimeModelForCustomProvider(provider, modelId);
  if (!model) return sendJson(ctx.res, 409, { error: "provider_not_ready", message: "the saved model is not active" });
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
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.test",
    resource: `${id}/${modelId}`,
    scopeLabel: orgScope(ctx.deps),
    status: "attempted",
  });
  const startedAt = Date.now();
  const recordResult = (status: "succeeded" | "failed") =>
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}`,
      scopeLabel: orgScope(ctx.deps),
      status,
      detail: `latencyMs=${Date.now() - startedAt}`,
    });
  try {
    const testModel = { ...model, maxTokens: Math.min(model.maxTokens, 128) };
    const reply = await oneShot(
      "admin-model-test",
      testModel as unknown as Model<Api>,
      { [id]: apiKey },
      "You are testing a model connection for an organization administrator.",
      "Reply with a short confirmation that the model connection works.",
      { signal: AbortSignal.timeout(30_000), disableRetries: true },
    );
    if (!reply?.trim()) {
      recordResult("failed");
      return sendJson(ctx.res, 502, { error: "provider_test_failed", message: "the model returned no text" });
    }
    recordResult("succeeded");
    return sendJson(ctx.res, 200, {
      ok: true,
      providerId: id,
      modelId,
      reply: reply.trim(),
      latencyMs: Date.now() - startedAt,
      maxOutputTokens: testModel.maxTokens,
    });
  } catch {
    recordResult("failed");
    return sendJson(ctx.res, 502, { error: "provider_test_failed", message: "the saved model request failed" });
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
