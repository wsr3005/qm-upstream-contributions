import { createPgPool } from "../persistence/pg-pool.ts";
import type { BudgetTracker } from "./budget.ts";
import { DEFAULT_BUDGET_WINDOW_MS } from "./budget.ts";

export function createPostgresBudgetTracker(
  connectionString: string,
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const orgKey = "@org";
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS budget_spend(
        id BIGSERIAL PRIMARY KEY,
        spend_kind TEXT,
        principal_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        usd DOUBLE PRECISION NOT NULL
      )`,
    `ALTER TABLE budget_spend ADD COLUMN IF NOT EXISTS spend_kind TEXT`,
    `UPDATE budget_spend
       SET spend_kind = CASE WHEN principal_id = '@org' THEN 'organization' ELSE 'member' END
       WHERE spend_kind IS NULL`,
    `CREATE INDEX IF NOT EXISTS budget_spend_by_principal_at ON budget_spend(principal_id, at)`,
  ]);

  async function spentIn(spendKind: "member" | "organization", principalId: string, now: number): Promise<number> {
    const legacy = spendKind === "organization" ? "principal_id = '@org'" : "principal_id <> '@org'";
    const rows = await q(
      `SELECT COALESCE(SUM(usd), 0) AS spent
       FROM budget_spend
       WHERE (spend_kind = $1 OR (spend_kind IS NULL AND ${legacy}))
         AND principal_id = $2
         AND at >= $3`,
      [spendKind, principalId, now - windowMs],
    );
    return Number(rows[0]?.spent ?? 0);
  }

  return {
    async check(principalId, now = Date.now()) {
      const spentUsd = await spentIn("member", principalId, now);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgSpent = await spentIn("organization", orgKey, now);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(principalId, costUsd, now = Date.now()) {
      try {
        for (const [spendKind, key] of [
          ["member", principalId],
          ["organization", orgKey],
        ] as const) {
          const legacy = spendKind === "organization" ? "principal_id = '@org'" : "principal_id <> '@org'";
          await q(
            `WITH ins AS (
               INSERT INTO budget_spend(spend_kind, principal_id, at, usd) VALUES ($1, $2, $3, $4)
             )
             DELETE FROM budget_spend
             WHERE (spend_kind = $1 OR (spend_kind IS NULL AND ${legacy}))
               AND principal_id = $2
               AND at < $5`,
            [spendKind, key, now, costUsd, now - windowMs],
          );
        }
      } catch (err) {
        console.error("[budget] failed to persist spend:", err);
      }
    },
    async usage(principalId, now = Date.now()) {
      const [memberSpent, organizationSpent] = await Promise.all([
        spentIn("member", principalId, now),
        spentIn("organization", orgKey, now),
      ]);
      return {
        windowMs,
        member: { spentUsd: memberSpent, limitUsd: Number.isFinite(limitUsd) ? limitUsd : null },
        organization: {
          spentUsd: organizationSpent,
          limitUsd: Number.isFinite(orgLimitUsd) ? orgLimitUsd : null,
        },
      };
    },
  };
}
