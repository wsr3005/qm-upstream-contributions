import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the schema-lock test";
const TABLE = "schema_lock_concurrent_index_it";
const PEER_TABLE = "schema_lock_peer_it";
const INDEX = "schema_lock_concurrent_index_it_value_idx";
const LEGACY_TABLE = "schema_lock_legacy_waiter_it";
const LEGACY_INDEX = "schema_lock_legacy_waiter_it_value_idx";
const TIMEOUT_TABLE = "schema_lock_timeout_restore_it";
const TIMEOUT_INDEX = "schema_lock_timeout_restore_it_value_idx";

async function clean(): Promise<void> {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}, ${PEER_TABLE}, ${LEGACY_TABLE}, ${TIMEOUT_TABLE} CASCADE`);
  await pool.end();
}

before(clean);
after(clean);

test("schema lock waiters do not deadlock a concurrent index during parallel startup", { skip }, async () => {
  const pg = (await import("pg")).default;
  const observer = new pg.Pool({ connectionString: URL });
  const first = createPgPool(URL!, []);
  const second = createPgPool(URL!, []);
  await Promise.all([first.pool(), second.pool()]);
  await observer.query(`CREATE TABLE ${TABLE} (id BIGSERIAL PRIMARY KEY, value TEXT NOT NULL)`);
  const blocker = await observer.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`INSERT INTO ${TABLE} (value) VALUES ('held')`);
    const firstDdl = first.schema!(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON ${TABLE} (value)`);
    let indexStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const active = await observer.query<{ active: string }>(
        "SELECT count(*)::text AS active FROM pg_stat_activity WHERE query LIKE $1 AND state <> 'idle'",
        [`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX}%`],
      );
      if (active.rows[0]?.active !== "0") {
        indexStarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(indexStarted, true);
    const secondDdl = second.schema!(`CREATE TABLE IF NOT EXISTS ${PEER_TABLE} (id BIGINT PRIMARY KEY)`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query("COMMIT");
    await Promise.race([
      Promise.all([firstDdl, secondDdl]),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("parallel schema startup timed out")), 5_000);
        timer.unref();
      }),
    ]);
    const state = await observer.query<{ valid: boolean }>(
      "SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)",
      [INDEX],
    );
    assert.equal(state.rows[0]?.valid, true);
    const peer = await observer.query<{ name: string | null }>("SELECT to_regclass($1)::text AS name", [PEER_TABLE]);
    assert.equal(peer.rows[0]?.name, PEER_TABLE);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.all([first.close(), second.close(), observer.end()]);
  }
});

test("concurrent index startup yields to a legacy blocking schema-lock waiter", { skip }, async () => {
  const pg = (await import("pg")).default;
  const observer = new pg.Pool({ connectionString: URL });
  const current = createPgPool(URL!, []);
  await current.pool();
  await observer.query(`CREATE TABLE ${LEGACY_TABLE} (id BIGSERIAL PRIMARY KEY, value TEXT NOT NULL)`);
  const blocker = await observer.connect();
  const legacy = await observer.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`INSERT INTO ${LEGACY_TABLE} (value) VALUES ('held')`);
    const statement = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${LEGACY_INDEX} ON ${LEGACY_TABLE} (value)`;
    const currentDdl = current.schema!(statement);
    let indexStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const active = await observer.query<{ active: string }>(
        "SELECT count(*)::text AS active FROM pg_stat_activity WHERE query LIKE $1 AND state <> 'idle'",
        [`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${LEGACY_INDEX}%`],
      );
      if (active.rows[0]?.active !== "0") {
        indexStarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(indexStarted, true);
    const legacyDdl = (async () => {
      await legacy.query("SELECT pg_advisory_lock(hashtext('agent-platform:schema-init'))");
      try {
        const existing = await legacy.query(
          "SELECT NOT indisvalid OR NOT indisready AS invalid FROM pg_index WHERE indexrelid = to_regclass($1)",
          [LEGACY_INDEX],
        );
        if (existing.rows[0]?.invalid) await legacy.query(`DROP INDEX CONCURRENTLY ${LEGACY_INDEX}`);
        await legacy.query(statement);
      } finally {
        await legacy.query("SELECT pg_advisory_unlock(hashtext('agent-platform:schema-init'))");
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await blocker.query("COMMIT");
    await Promise.race([
      Promise.all([currentDdl, legacyDdl]),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("mixed-version schema startup timed out")), 8_000);
        timer.unref();
      }),
    ]);
    const state = await observer.query<{ valid: boolean }>(
      "SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)",
      [LEGACY_INDEX],
    );
    assert.equal(state.rows[0]?.valid, true);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await legacy.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
    blocker.release();
    legacy.release();
    await Promise.all([current.close(), observer.end()]);
  }
});

test("concurrent index startup restores the caller's session lock timeout", { skip }, async () => {
  const pg = (await import("pg")).default;
  const observer = new pg.Pool({ connectionString: URL });
  const current = createPgPool(URL!, []);
  try {
    await current.pool();
    await observer.query(`CREATE TABLE ${TIMEOUT_TABLE} (id BIGSERIAL PRIMARY KEY, value TEXT NOT NULL)`);
    const client = await (await current.pool()).connect();
    await client.query("SET lock_timeout = '1234ms'");
    client.release();

    await current.schema!(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TIMEOUT_INDEX} ON ${TIMEOUT_TABLE} (value)`);
    const timeout = await current.q("SHOW lock_timeout");
    assert.equal(timeout[0]?.lock_timeout, "1234ms");
  } finally {
    await Promise.all([current.close(), observer.end()]);
  }
});
