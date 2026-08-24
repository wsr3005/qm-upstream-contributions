import type { PgPool } from "../persistence/pg-pool.ts";

export interface InstanceRegistry {
  beat(): Promise<boolean>;
  allLiveSupport?(capability: string): Promise<boolean>;
  capabilitySnapshot?(capability: string): Promise<{ ready: boolean; epoch: string }>;
}

const INSTANCE_LIVENESS_MS = 30_000;
const INCOMPATIBLE_GRACE_MS = 120_000;

export function createNoopInstanceRegistry(): InstanceRegistry {
  return { beat: async () => false };
}

export function createPostgresInstanceRegistry(
  pg: PgPool,
  opts: {
    instanceId: string;
    buildSha: string;
    startedAt: number;
    livenessMs?: number;
    incompatibleGraceMs?: number;
    capabilities?: readonly string[];
  },
): InstanceRegistry {
  const livenessMs = opts.livenessMs ?? INSTANCE_LIVENESS_MS;
  const incompatibleGraceMs = opts.incompatibleGraceMs ?? INCOMPATIBLE_GRACE_MS;
  const capabilities = [...(opts.capabilities ?? [])];
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = pg
        .query(
          `CREATE TABLE IF NOT EXISTS instance_heartbeats(
             instance_id TEXT PRIMARY KEY,
             build_sha TEXT NOT NULL,
             started_at BIGINT NOT NULL,
             beat_at TIMESTAMPTZ NOT NULL,
             capabilities TEXT[] NOT NULL DEFAULT '{}'
           )`,
        )
        .then(() =>
          pg.query(
            `ALTER TABLE instance_heartbeats ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}'`,
          ),
        )
        .then(() =>
          pg.query(
            `CREATE TABLE IF NOT EXISTS instance_registry_state(
               singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
               capability_epoch BIGINT NOT NULL DEFAULT 0
             )`,
          ),
        )
        .then(() =>
          pg.query(
            `INSERT INTO instance_registry_state(singleton, capability_epoch)
               VALUES (true, 0)
             ON CONFLICT (singleton) DO NOTHING`,
          ),
        )
        .then(() => undefined)
        .catch((e) => {
          readyP = null;
          throw e;
        });
    }
    return readyP;
  }

  async function capabilitySnapshot(capability: string): Promise<{ ready: boolean; epoch: string }> {
    await ready();
    const { rows } = await pg.query(
      `SELECT
         (SELECT capability_epoch::text FROM instance_registry_state WHERE singleton = true) AS epoch,
         EXISTS(
           SELECT 1 FROM instance_heartbeats
            WHERE instance_id = $1
              AND beat_at > now() - ($3 || ' milliseconds')::interval
              AND $2::text = ANY(capabilities)
         ) AS current_live,
         NOT EXISTS(
           SELECT 1 FROM instance_heartbeats
            WHERE beat_at > now() - ($4 || ' milliseconds')::interval
              AND NOT ($2::text = ANY(capabilities))
         ) AS all_live_support`,
      [opts.instanceId, capability, String(livenessMs), String(incompatibleGraceMs)],
    );
    return {
      ready: rows[0]?.current_live === true && rows[0]?.all_live_support === true,
      epoch: String(rows[0]?.epoch ?? "0"),
    };
  }

  return {
    async beat(): Promise<boolean> {
      await ready();
      await pg.query(
        `WITH prior AS MATERIALIZED (
           SELECT capabilities,
                  beat_at > now() - ($5 || ' milliseconds')::interval AS was_live
             FROM instance_heartbeats
            WHERE instance_id = $1
         ), upserted AS (
           INSERT INTO instance_heartbeats(instance_id, build_sha, started_at, beat_at, capabilities)
             VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (instance_id) DO UPDATE
             SET beat_at = now(), capabilities = EXCLUDED.capabilities
           RETURNING 1
         )
         UPDATE instance_registry_state
            SET capability_epoch = capability_epoch + 1
          WHERE singleton = true
            AND EXISTS (SELECT 1 FROM upserted)
            AND (
              NOT EXISTS (SELECT 1 FROM prior)
              OR NOT COALESCE((SELECT was_live FROM prior), false)
              OR (SELECT capabilities FROM prior) IS DISTINCT FROM $4::text[]
            )`,
        [opts.instanceId, opts.buildSha, String(opts.startedAt), capabilities, String(livenessMs)],
      );
      await pg.query(`DELETE FROM instance_heartbeats WHERE beat_at < now() - interval '1 hour'`, []);
      const { rowCount } = await pg.query(
        `SELECT 1 FROM instance_heartbeats
          WHERE build_sha <> $1 AND started_at > $2
            AND beat_at > now() - ($3 || ' milliseconds')::interval
          LIMIT 1`,
        [opts.buildSha, String(opts.startedAt), String(livenessMs)],
      );
      return rowCount > 0;
    },

    capabilitySnapshot,

    async allLiveSupport(capability): Promise<boolean> {
      const snapshot = await capabilitySnapshot(capability);
      return snapshot.ready;
    },
  };
}
