import type { PgPool, Pool, PoolClient } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

type SlotRelease = () => void;
type PoolSlotWaiter = { resolve: (release: SlotRelease | null) => void; timer: ReturnType<typeof setTimeout> };
type PoolSlots = { active: number; max: number; waiters: Set<PoolSlotWaiter> };
type AdvisoryClient = { client: PoolClient; release: SlotRelease };

const poolSlots = new WeakMap<Pool, PoolSlots>();

function slotsFor(pool: Pool): PoolSlots {
  let slots = poolSlots.get(pool);
  if (!slots) {
    slots = { active: 0, max: pool.options.max, waiters: new Set() };
    poolSlots.set(pool, slots);
  }
  return slots;
}

function releaseSlot(slots: PoolSlots): void {
  slots.active -= 1;
  const next = slots.waiters.values().next().value as PoolSlotWaiter | undefined;
  if (!next) return;
  slots.waiters.delete(next);
  clearTimeout(next.timer);
  slots.active += 1;
  let released = false;
  next.resolve(() => {
    if (released) return;
    released = true;
    releaseSlot(slots);
  });
}

function reserveSlotBefore(pool: Pool, deadline: number): Promise<SlotRelease | null> {
  const slots = slotsFor(pool);
  if (slots.active < slots.max) {
    slots.active += 1;
    let released = false;
    return Promise.resolve(() => {
      if (released) return;
      released = true;
      releaseSlot(slots);
    });
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter: PoolSlotWaiter = {
      resolve,
      timer: setTimeout(() => {
        slots.waiters.delete(waiter);
        resolve(null);
      }, remaining),
    };
    waiter.timer.unref();
    slots.waiters.add(waiter);
  });
}

async function connectBefore(pool: Pool, deadline: number): Promise<AdvisoryClient | null> {
  const slot = await reserveSlotBefore(pool, deadline);
  if (!slot) return null;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    slot();
    return null;
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connected = pool.connect().then(
    (client) => {
      if (expired || Date.now() >= deadline) {
        client.release();
        slot();
        return null;
      }
      if (timer) clearTimeout(timer);
      return {
        client,
        release() {
          client.release();
          slot();
        },
      };
    },
    (error) => {
      if (timer) clearTimeout(timer);
      slot();
      throw error;
    },
  );
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(null);
    }, remaining);
    timer.unref();
  });
  return Promise.race<AdvisoryClient | null>([connected, timedOut]);
}

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  };
}

export function createMemoryAdvisoryLock(): AdvisoryLock {
  const queue = createKeyedQueue<string>();
  const held = new Set<string>();
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    queue(key, async () => {
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    });
  return {
    withLock,
    async tryWithLock(key, fn) {
      if (held.has(key)) return null;
      return withLock(key, fn);
    },
  };
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;

  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      const pool = await pg.pool();
      for (;;) {
        const connection = await connectBefore(pool, deadline);
        if (!connection) throw new Error(`timeout acquiring advisory lock for ${key}`);
        const { client } = connection;
        try {
          const res = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [key],
          );
          const held = res.rows[0]?.locked === true;
          if (held) {
            try {
              return await fn();
            } finally {
              await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
            }
          }
        } finally {
          connection.release();
        }
        if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
    },

    async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      const pool = await pg.pool();
      const connection = await connectBefore(pool, Date.now() + Math.max(1, Math.min(timeoutMs, pollMs)));
      if (!connection) return null;
      const { client } = connection;
      try {
        const res = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [key],
        );
        if (res.rows[0]?.locked !== true) return null;
        try {
          return await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        }
      } finally {
        connection.release();
      }
    },
  };
}
