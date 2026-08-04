import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../model/pi-models.ts";
export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
}

export interface BudgetUsageSnapshot {
  windowMs: number;
  member: Omit<BudgetCheck, "allowed">;
  organization: Omit<BudgetCheck, "allowed">;
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
  snapshot(principalId: string, now?: number): Promise<BudgetUsageSnapshot>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}

export function createBudgetTracker(
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const spend = new Map<string, Array<{ at: number; usd: number }>>();
  const orgKey = "@org";

  function spentIn(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (spend.get(principalId) ?? []).filter((e) => e.at >= cutoff);
    spend.set(principalId, kept);
    return kept.reduce((s, e) => s + e.usd, 0);
  }

  async function snapshot(principalId: string, now = Date.now()): Promise<BudgetUsageSnapshot> {
    return {
      windowMs,
      member: { spentUsd: spentIn(principalId, now), limitUsd },
      organization: { spentUsd: spentIn(orgKey, now), limitUsd: orgLimitUsd },
    };
  }

  return {
    async check(principalId, now = Date.now()) {
      const usage = await snapshot(principalId, now);
      if (usage.member.spentUsd >= usage.member.limitUsd) {
        return { allowed: false, ...usage.member };
      }
      return { allowed: usage.organization.spentUsd < usage.organization.limitUsd, ...usage.organization };
    },
    async record(principalId, costUsd, now = Date.now()) {
      for (const key of [principalId, orgKey]) {
        const list = spend.get(key) ?? [];
        list.push({ at: now, usd: costUsd });
        spend.set(key, list);
      }
    },
    snapshot,
  };
}
