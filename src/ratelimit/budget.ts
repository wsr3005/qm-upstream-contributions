import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../model/pi-models.ts";
interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
}

export interface BudgetUsage {
  windowMs: number;
  member: { spentUsd: number; limitUsd: number | null };
  organization: { spentUsd: number; limitUsd: number | null };
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
  usage(principalId: string, now?: number): Promise<BudgetUsage>;
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
  const memberSpend = new Map<string, Array<{ at: number; usd: number }>>();
  let organizationSpend: Array<{ at: number; usd: number }> = [];

  function memberSpentIn(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (memberSpend.get(principalId) ?? []).filter((e) => e.at >= cutoff);
    memberSpend.set(principalId, kept);
    return kept.reduce((s, e) => s + e.usd, 0);
  }

  function organizationSpentIn(now: number): number {
    const cutoff = now - windowMs;
    organizationSpend = organizationSpend.filter((entry) => entry.at >= cutoff);
    return organizationSpend.reduce((sum, entry) => sum + entry.usd, 0);
  }

  return {
    async check(principalId, now = Date.now()) {
      const spentUsd = memberSpentIn(principalId, now);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgSpent = organizationSpentIn(now);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(principalId, costUsd, now = Date.now()) {
      const member = memberSpend.get(principalId) ?? [];
      member.push({ at: now, usd: costUsd });
      memberSpend.set(principalId, member);
      organizationSpend.push({ at: now, usd: costUsd });
    },
    async usage(principalId, now = Date.now()) {
      return {
        windowMs,
        member: {
          spentUsd: memberSpentIn(principalId, now),
          limitUsd: Number.isFinite(limitUsd) ? limitUsd : null,
        },
        organization: {
          spentUsd: organizationSpentIn(now),
          limitUsd: Number.isFinite(orgLimitUsd) ? orgLimitUsd : null,
        },
      };
    },
  };
}
