import {
  CUSTOM_PROVIDER_PROTOCOLS,
  runtimeModelForCustomProvider,
  validateCustomProviderSpec,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import {
  CustomProviderRuntimeNotReadyError,
  requiredCustomProviderRuntimeSchema,
} from "../../../model/custom-provider-store.ts";
import { resolveStaticModel } from "../../../model/pi-models.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, auditRequired, authorizeAdmin, orgScope } from "../shared.ts";
import {
  CustomProviderHarnessTestRolloutIncompleteError,
  CustomProviderTestConfigurationChangedError,
  type CustomProviderTestHarness,
} from "../../deps.ts";
import {
  customProviderTestReceiptId,
  customProviderTestRequestFingerprint,
  type CustomProviderTestRunClaim,
  type CustomProviderTestRunResponse,
} from "../../../model/custom-provider-test-runs.ts";
import { isValidModelTestProxyEvidence, MODEL_TEST_MAX_OUTPUT_TOKENS } from "../../../harness/model-test-proxy.ts";

const TEST_HARNESSES = new Set<CustomProviderTestHarness>(["pi", "opencode", "codex"]);
const TEST_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
  const requiredRuntimeSchema = requiredCustomProviderRuntimeSchema(spec);
  if (
    requiredRuntimeSchema !== undefined &&
    !(await ctx.deps.customProviders.runtimeSchemaWritable(requiredRuntimeSchema))
  ) {
    return sendJson(ctx.res, 409, {
      error: "runtime_rollout_incomplete",
      message: "custom model configuration is unavailable until the compatibility rollout is complete",
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
    await ctx.deps.customProviders.upsert(spec, apiKey, authorized.id, { stage: true });
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
  const body = ctx.body as {
    modelId?: unknown;
    harness?: unknown;
    requestId?: unknown;
    draft?: {
      name?: unknown;
      protocol?: unknown;
      baseUrl?: unknown;
      models?: unknown;
      apiKey?: unknown;
    };
  };
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
  if (typeof body.requestId !== "string" || !TEST_REQUEST_ID.test(body.requestId)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "requestId is required and must be 1-128 letters, numbers, dots, colons, underscores, or hyphens",
    });
  }
  const requestId = body.requestId;
  const sendTestJson = (status: number, response: Record<string, unknown>) =>
    sendJson(ctx.res, status, { ...response, requestId });
  const readRolloutFence = ctx.deps.customProviderHarnessTestFence ?? (async () => null);
  let draft: { provider: CustomProviderSpec; apiKey: string } | undefined;
  let configurationFingerprint: string | undefined;
  if (body.draft !== undefined) {
    if (
      !body.draft ||
      typeof body.draft !== "object" ||
      typeof body.draft.name !== "string" ||
      typeof body.draft.protocol !== "string" ||
      typeof body.draft.baseUrl !== "string" ||
      typeof body.draft.apiKey !== "string" ||
      !body.draft.apiKey.trim() ||
      !(CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(body.draft.protocol)
    ) {
      return sendTestJson(400, { error: "bad_request", message: "a complete draft provider and API key are required" });
    }
    const submittedModels = Array.isArray(body.draft.models) ? (body.draft.models as CustomProviderSpec["models"]) : [];
    const provider: CustomProviderSpec = {
      id,
      name: body.draft.name,
      protocol: body.draft.protocol as CustomProviderProtocol,
      baseUrl: body.draft.baseUrl.trim().replace(/\/+$/, ""),
      models: submittedModels.map((model) =>
        typeof model?.id === "string" && resolveStaticModel(model.id)
          ? { ...model, id: `${id}/${model.id}`, upstreamId: model.upstreamId ?? model.id }
          : model,
      ),
    };
    try {
      validateCustomProviderSpec(provider);
    } catch (error) {
      return sendTestJson(400, { error: "bad_request", message: (error as Error).message });
    }
    draft = { provider, apiKey: body.draft.apiKey.trim() };
    configurationFingerprint = ctx.deps.customProviders.fingerprintSensitive(
      JSON.stringify([provider, body.draft.apiKey.trim()]),
    );
  }
  const initialState = draft
    ? { active: { ...draft, revision: 0 }, rolloutFence: await readRolloutFence() }
    : await ctx.deps.customProviders.testableHarnessState(id, readRolloutFence).catch(() => null);
  if (!initialState) {
    return sendTestJson(502, { error: "provider_test_failed", message: "the saved test state could not be read" });
  }
  const rolloutFence = initialState.rolloutFence;
  if (!rolloutFence) {
    return sendTestJson(409, {
      error: "harness_test_rollout_incomplete",
      message: "model testing is unavailable until every live QM runtime supports this test version",
    });
  }
  const active = initialState.active;
  if (!active) return sendTestJson(404, { error: "not_found" });
  const { provider, apiKey, revision } = active;
  const selectedModelId = draft && resolveStaticModel(modelId) ? `${id}/${modelId}` : modelId;
  if (!provider.models.some((model) => model.id === selectedModelId)) {
    return sendTestJson(400, {
      error: "bad_request",
      message: `model "${modelId}" is not registered to ${id}`,
    });
  }
  if (!apiKey) {
    return sendTestJson(400, { error: "missing_api_key", message: "this provider has no active API key" });
  }
  const model = runtimeModelForCustomProvider(provider, selectedModelId);
  if (!model) return sendTestJson(409, { error: "provider_not_ready", message: "the saved model is not active" });
  if (harnessId === "codex" && provider.protocol !== "openai-responses") {
    return sendTestJson(400, {
      error: "harness_not_supported",
      message: `${harnessId} does not support this provider protocol`,
    });
  }
  if (!ctx.deps.customProviderHarnessTest) {
    return sendTestJson(503, {
      error: "harness_test_unavailable",
      message: "model testing is unavailable on this QM runtime",
    });
  }
  if (!ctx.deps.customProviderTestRuns || (ctx.deps.production && !ctx.deps.customProviderTestRuns.durable)) {
    return sendTestJson(503, {
      error: "harness_test_guard_unavailable",
      message: "model testing is unavailable until its durable billing guard is ready",
    });
  }
  const testHarness = harnessId as CustomProviderTestHarness;
  const upstreamModelId = model.id;
  const testIdentity = {
    scopeId: orgScope(ctx.deps),
    providerId: id,
    modelId: selectedModelId,
    harnessId: testHarness,
    providerRevision: revision,
    rolloutFence,
    ...(configurationFingerprint ? { configurationFingerprint } : {}),
  };
  const requestIdHash = customProviderTestReceiptId(requestId);
  const requestFingerprint = customProviderTestRequestFingerprint(testIdentity);
  const auditCorrelation = `requestIdHash=${requestIdHash}`;
  let claim: CustomProviderTestRunClaim;
  try {
    claim = await ctx.deps.customProviderTestRuns.claim(testIdentity, requestId);
  } catch {
    return sendTestJson(503, {
      error: "harness_test_guard_unavailable",
      message: "the paid test was not started because its durable billing guard could not be reached",
    });
  }
  if (claim.kind === "conflict") {
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status: "conflict",
      detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision} ${auditCorrelation}`,
    });
    return sendTestJson(409, {
      error: "harness_test_request_conflict",
      message: "requestId was already used for a different saved model test",
    });
  }
  if (claim.kind === "unresolved") {
    ctx.res.setHeader("retry-after", String(Math.max(1, Math.ceil(claim.retryAfterMs / 1000))));
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status: "unresolved",
      detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision} retryAfterMs=${claim.retryAfterMs} ${auditCorrelation}`,
    });
    return sendTestJson(409, {
      error: "harness_test_result_unresolved",
      message:
        "the prior paid test no longer has a running owner or saved result; wait for its safety window before starting a new paid test",
      retryAfterMs: claim.retryAfterMs,
      requestExpiresInMs: Math.max(1, claim.requestExpiresAt - Date.now()),
    });
  }
  if (claim.kind === "running") {
    const retryAfterMs = Math.max(1, Math.min(2_000, claim.retryAfterMs));
    ctx.res.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status: "busy",
      detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision} retryAfterMs=${retryAfterMs} requestExpiresAt=${claim.requestExpiresAt ?? "none"} ${auditCorrelation}`,
    });
    return sendTestJson(409, {
      error: "harness_test_in_progress",
      message: claim.replayExpected
        ? "the same paid test is already running; retry this requestId after it finishes to read the shared saved result"
        : "an older saved configuration is still being tested; retry later to start a new paid test for the current configuration",
      retryAfterMs,
      replayExpected: claim.replayExpected,
      ...(claim.requestExpiresAt === undefined
        ? {}
        : { requestExpiresInMs: Math.max(1, claim.requestExpiresAt - Date.now()) }),
    });
  }
  if (claim.kind === "replay") {
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status: "replayed",
      detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision} completedAt=${claim.completedAt} ${auditCorrelation}`,
    });
    return sendTestJson(claim.response.status, {
      ...claim.response.body,
      cached: true,
      cachedAt: claim.completedAt,
      cachedUntil: claim.expiresAt,
    });
  }
  const auditRunId = createHash("sha256")
    .update(JSON.stringify([requestFingerprint, requestIdHash, claim.owner]))
    .digest("hex");
  const attemptedAudit = await auditRequired(ctx.deps, `custom-provider-test:${auditRunId}:attempted`, {
    principalId: authorized.id,
    action: "custom-providers.test",
    resource: `${id}/${modelId}/${testHarness}`,
    scopeLabel: orgScope(ctx.deps),
    status: "attempted",
    detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision} ${auditCorrelation}`,
  });
  if (!attemptedAudit) {
    const response = {
      status: 503,
      body: {
        error: "harness_test_audit_unavailable",
        message: "the paid test was not started because its durable audit record could not be written",
        requestId,
        providerRevision: revision,
        testedAt: Date.now(),
      },
    };
    await ctx.deps.customProviderTestRuns.complete(claim, response).catch(() => false);
    return sendTestJson(response.status, response.body);
  }
  const startedAt = Date.now();
  const recordResult = (
    status: "succeeded" | "failed",
    identity: { upstreamModelId: string; providerRevision: number } = { upstreamModelId, providerRevision: revision },
    metrics = "",
  ) =>
    auditRequired(ctx.deps, `custom-provider-test:${auditRunId}:${status}`, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status,
      detail: `harness=${testHarness} upstreamModelId=${identity.upstreamModelId} providerRevision=${identity.providerRevision} latencyMs=${Date.now() - startedAt}${metrics} ${auditCorrelation}`,
    });
  let response: CustomProviderTestRunResponse;
  try {
    const result = await ctx.deps.customProviderHarnessTest({
      providerId: id,
      modelId: selectedModelId,
      harnessId: testHarness,
      expectedRevision: revision,
      rolloutFence,
      signal: AbortSignal.timeout(60_000),
      ...(draft ? { draft } : {}),
    });
    const finalState = draft
      ? { active: { ...draft, revision: 0 }, rolloutFence: await readRolloutFence() }
      : await ctx.deps.customProviders.testableHarnessState(id, readRolloutFence);
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
    const evidence = result.evidence;
    const maxOutputTokens = result.maxOutputTokens;
    if (
      !reply?.trim() ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens! <= 0 ||
      maxOutputTokens! > MODEL_TEST_MAX_OUTPUT_TOKENS ||
      !isValidModelTestProxyEvidence(evidence, result.upstreamModelId, maxOutputTokens!)
    ) {
      const audited = await recordResult("failed", identity);
      response = audited
        ? {
            status: 502,
            body: { error: "provider_test_failed", message: "the model response could not be verified" },
          }
        : {
            status: 503,
            body: { error: "harness_test_audit_unavailable", message: "the paid result could not be durably audited" },
          };
    } else {
      const audited = await recordResult(
        "succeeded",
        identity,
        ` responseModel=${evidence.responseModel} firstTokenMs=${evidence.firstTokenMs} providerTotalMs=${evidence.totalMs} inputTokens=${evidence.usage.inputTokens} outputTokens=${evidence.usage.outputTokens} totalTokens=${evidence.usage.totalTokens} cachedInputTokens=${evidence.usage.cachedInputTokens} cacheCreationInputTokens=${evidence.usage.cacheCreationInputTokens} maxOutputTokens=${maxOutputTokens} streamed=${evidence.streamed} upstreamRequests=${evidence.upstreamRequests}`,
      );
      if (audited && !draft) {
        const verified = await ctx.deps.customProviders.recordVerification(
          id,
          revision,
          selectedModelId,
          testHarness,
          Date.now(),
        );
        if (!verified) throw new CustomProviderTestConfigurationChangedError("custom provider changed during the test");
      }
      response = audited
        ? {
            status: 200,
            body: {
              ok: true,
              providerId: id,
              modelId,
              upstreamModelId: result.upstreamModelId,
              requestedModel: evidence.requestedModel,
              endpointAlias: provider.name,
              harness: testHarness,
              reply: reply.trim(),
              latencyMs: Date.now() - startedAt,
              responseModel: evidence.responseModel,
              firstTokenMs: evidence.firstTokenMs,
              providerTotalMs: evidence.totalMs,
              usage: evidence.usage,
              streamed: evidence.streamed,
              upstreamRequests: evidence.upstreamRequests,
              noDefaultEgress: true,
              maxOutputTokens,
            },
          }
        : {
            status: 503,
            body: { error: "harness_test_audit_unavailable", message: "the paid result could not be durably audited" },
          };
    }
  } catch (error) {
    const audited = await recordResult("failed");
    if (!audited) {
      response = {
        status: 503,
        body: { error: "harness_test_audit_unavailable", message: "the paid result could not be durably audited" },
      };
    } else if (error instanceof CustomProviderHarnessTestRolloutIncompleteError) {
      response = {
        status: 409,
        body: {
          error: "harness_test_rollout_incomplete",
          message: "model testing became unavailable during a mixed-version rollout; retry after rollout completes",
        },
      };
    } else if (error instanceof CustomProviderTestConfigurationChangedError) {
      response = {
        status: 409,
        body: {
          error: "provider_changed_during_test",
          message: "the provider configuration changed during the test; retry to verify the current version",
        },
      };
    } else {
      response = {
        status: 502,
        body: {
          error: "provider_test_failed",
          message: `${testHarness} could not complete the saved model request`,
        },
      };
    }
  }
  response = {
    status: response.status,
    body: { ...response.body, requestId, providerRevision: revision, testedAt: Date.now() },
  };
  try {
    const stored = await ctx.deps.customProviderTestRuns.complete(claim, response);
    if (!stored) throw new Error("paid test lease changed before its result was persisted");
  } catch {
    const retryAfterMs = Math.max(1, claim.requestExpiresAt - Date.now());
    ctx.res.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "custom-providers.test",
      resource: `${id}/${modelId}/${testHarness}`,
      scopeLabel: orgScope(ctx.deps),
      status: "result_unpersisted",
      detail: `harness=${testHarness} upstreamModelId=${upstreamModelId} providerRevision=${revision} retryAfterMs=${retryAfterMs} ${auditCorrelation}`,
    });
    return sendTestJson(503, {
      error: "harness_test_result_not_durable",
      message:
        "the paid test finished but its result could not be stored; do not retry until the safety window expires",
      retryAfterMs,
      requestExpiresInMs: retryAfterMs,
    });
  }
  return sendTestJson(response.status, response.body);
}

export async function publishCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "a JSON object is required" });
  }
  const revision = Number((ctx.body as { revision?: unknown }).revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "revision is required" });
  }
  const status = (await ctx.deps.customProviders.statuses()).find((provider) => provider.id === id);
  if (!status || status.revision !== revision) {
    return sendJson(ctx.res, 409, { error: "provider_changed", message: "the provider changed before publication" });
  }
  const harnesses = status.protocol === "openai-responses" ? ["pi", "opencode", "codex"] : ["pi", "opencode"];
  const requiredTargets = status.models.flatMap((model) =>
    harnesses.map((harnessId) => ({ modelId: model.id, harnessId })),
  );
  const published = await ctx.deps.customProviders.publish(id, revision, requiredTargets, authorized.id);
  if (!published) {
    return sendJson(ctx.res, 409, {
      error: "provider_not_verified",
      message: "every model must pass every supported Harness test for this revision before publication",
    });
  }
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.publish",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
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
import { createHash } from "node:crypto";
