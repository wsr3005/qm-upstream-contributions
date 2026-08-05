import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

export async function getBudgetUsage(ctx: ApiCtx): Promise<void> {
  const { deps, res, url } = ctx;
  if (!deps.budget) return sendJson(res, 404, { error: "not_found" });
  const scope = url.searchParams.get("scope") ?? "";
  const principalId = url.searchParams.get("principalId") ?? "";
  if (!scope || !principalId || principalId.length > 512 || /[\u0000-\u001f\u007f]/u.test(principalId)) {
    return sendJson(res, 400, { error: "bad_request" });
  }
  if (scope !== orgScope(deps)) return sendJson(res, 403, { error: "forbidden" });
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const usage = await deps.budget.usage(principalId);
  audit(deps, {
    principalId: actor.id,
    action: "budget-usage.read",
    resource: principalId,
    scopeLabel: scope,
  });
  return sendJson(res, 200, { scopeId: scope, principalId, approximate: true, ...usage });
}
