import { createHash, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";

export interface CustomProviderTestRunIdentity {
  scopeId: string;
  providerId: string;
  modelId: string;
  harnessId: string;
  providerRevision: number;
  rolloutFence: string;
  configurationFingerprint?: string;
  reservationFingerprint?: string;
}

export interface CustomProviderTestRunResponse {
  status: number;
  body: Record<string, unknown>;
}

interface StoredCustomProviderTestLease {
  owner: string;
  requestId: string;
  requestFingerprint: string;
  startedAt: number;
  expiresAt: number;
}

type StoredCustomProviderTestReceipt =
  | {
      state: "pending";
      owner: string;
      requestId: string;
      requestFingerprint: string;
      activeId: string;
      startedAt: number;
      expiresAt: number;
    }
  | {
      state: "completed";
      requestId: string;
      requestFingerprint: string;
      response: CustomProviderTestRunResponse;
      completedAt: number;
      expiresAt: number;
    };

export interface StoredCustomProviderTestRun {
  active: Record<string, StoredCustomProviderTestLease>;
  receipts: Record<string, StoredCustomProviderTestReceipt>;
}

export type ClaimedCustomProviderTestRun = {
  kind: "claimed";
  key: string;
  activeId: string;
  receiptId: string;
  owner: string;
  requestId: string;
  requestFingerprint: string;
  expiresAt: number;
  requestExpiresAt: number;
};

export type CustomProviderTestRunClaim =
  | ClaimedCustomProviderTestRun
  | { kind: "running"; retryAfterMs: number; replayExpected: boolean; requestExpiresAt?: number }
  | { kind: "unresolved"; retryAfterMs: number; requestExpiresAt: number }
  | { kind: "conflict" }
  | {
      kind: "replay";
      response: CustomProviderTestRunResponse;
      completedAt: number;
      expiresAt: number;
    };

export interface CustomProviderTestRunStore {
  readonly durable: boolean;
  claim(identity: CustomProviderTestRunIdentity, requestId: string): Promise<CustomProviderTestRunClaim>;
  complete(claim: ClaimedCustomProviderTestRun, response: CustomProviderTestRunResponse): Promise<boolean>;
  sweep(): Promise<number>;
}

export const CUSTOM_PROVIDER_TEST_RUNNING_TTL_MS = 5 * 60_000;
export const CUSTOM_PROVIDER_TEST_RESULT_TTL_MS = 5 * 60_000;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function customProviderTestRunKey(identity: CustomProviderTestRunIdentity): string {
  return `provider:${digest([identity.scopeId, identity.providerId])}`;
}

export function customProviderTestActiveId(identity: CustomProviderTestRunIdentity): string {
  return digest([identity.modelId, identity.harnessId]);
}

export function customProviderTestRequestFingerprint(identity: CustomProviderTestRunIdentity): string {
  return digest([
    identity.scopeId,
    identity.providerId,
    identity.modelId,
    identity.harnessId,
    identity.providerRevision,
    identity.rolloutFence,
    identity.configurationFingerprint ?? null,
    ...(identity.reservationFingerprint === undefined ? [] : [identity.reservationFingerprint]),
  ]);
}

export function customProviderTestReceiptId(requestId: string): string {
  return digest(requestId);
}

function pruneExpired(
  bucket: StoredCustomProviderTestRun,
  expiredAt: number,
): {
  bucket: StoredCustomProviderTestRun;
  removed: number;
} {
  const active = { ...bucket.active };
  const receipts = { ...bucket.receipts };
  let removed = 0;
  for (const [id, lease] of Object.entries(active)) {
    if (lease.expiresAt > expiredAt) continue;
    delete active[id];
    removed += 1;
  }
  for (const [id, receipt] of Object.entries(receipts)) {
    if (receipt.expiresAt > expiredAt) continue;
    delete receipts[id];
    removed += 1;
  }
  return { bucket: { active, receipts }, removed };
}

function sameLease(left: StoredCustomProviderTestLease | undefined, right: StoredCustomProviderTestLease): boolean {
  return (
    left?.owner === right.owner &&
    left.requestId === right.requestId &&
    left.requestFingerprint === right.requestFingerprint &&
    left.startedAt === right.startedAt &&
    left.expiresAt === right.expiresAt
  );
}

function samePendingReceipt(
  left: StoredCustomProviderTestReceipt | undefined,
  right: Extract<StoredCustomProviderTestReceipt, { state: "pending" }>,
): boolean {
  return (
    left?.state === "pending" &&
    left.owner === right.owner &&
    left.requestId === right.requestId &&
    left.requestFingerprint === right.requestFingerprint &&
    left.activeId === right.activeId &&
    left.startedAt === right.startedAt &&
    left.expiresAt === right.expiresAt
  );
}

async function putWithCommitRecovery(
  backing: DurableMap<StoredCustomProviderTestRun>,
  key: string,
  bucket: StoredCustomProviderTestRun,
  committed: (stored: StoredCustomProviderTestRun) => boolean,
): Promise<void> {
  try {
    await backing.put(key, bucket);
  } catch (error) {
    const stored: StoredCustomProviderTestRun | null = await backing.get(key).catch(() => null);
    if (stored && committed(stored)) return;
    throw error;
  }
}

export function createCustomProviderTestRunStore(input: {
  backing: DurableMap<StoredCustomProviderTestRun>;
  advisoryLock: AdvisoryLock;
  now?: () => number;
  ownerId?: () => string;
  runningTtlMs?: number;
  resultTtlMs?: number;
  durable?: boolean;
}): CustomProviderTestRunStore {
  const now = input.now ?? Date.now;
  const ownerId = input.ownerId ?? randomUUID;
  const runningTtlMs = input.runningTtlMs ?? CUSTOM_PROVIDER_TEST_RUNNING_TTL_MS;
  const resultTtlMs = input.resultTtlMs ?? CUSTOM_PROVIDER_TEST_RESULT_TTL_MS;
  const withRunLock = <T>(key: string, operation: () => Promise<T>): Promise<T> =>
    input.advisoryLock.withLock(`custom-provider-test:${key}`, operation);

  return {
    durable: input.durable ?? false,

    async claim(identity, requestId) {
      const key = customProviderTestRunKey(identity);
      const activeId = customProviderTestActiveId(identity);
      const receiptId = customProviderTestReceiptId(requestId);
      const requestFingerprint = customProviderTestRequestFingerprint(identity);
      return withRunLock(key, async () => {
        const claimedAt = now();
        const stored = (await input.backing.get(key)) ?? { active: {}, receipts: {} };
        const pruned = pruneExpired(stored, claimedAt).bucket;
        const receipt = pruned.receipts[receiptId];
        if (receipt) {
          if (receipt.requestId !== requestId || receipt.requestFingerprint !== requestFingerprint) {
            return { kind: "conflict" };
          }
          if (receipt.state === "completed") {
            return {
              kind: "replay",
              response: receipt.response,
              completedAt: receipt.completedAt,
              expiresAt: receipt.expiresAt,
            };
          }
          const active = pruned.active[receipt.activeId];
          if (!active || active.owner !== receipt.owner || active.requestFingerprint !== receipt.requestFingerprint) {
            return {
              kind: "unresolved",
              retryAfterMs: receipt.expiresAt - claimedAt,
              requestExpiresAt: receipt.expiresAt,
            };
          }
          return {
            kind: "running",
            retryAfterMs: active.expiresAt - claimedAt,
            replayExpected: true,
            requestExpiresAt: receipt.expiresAt,
          };
        }
        const existing = pruned.active[activeId];
        if (existing) {
          const replayExpected = existing.requestFingerprint === requestFingerprint;
          let requestExpiresAt: number | undefined;
          if (replayExpected) {
            requestExpiresAt = Math.max(existing.expiresAt, claimedAt + resultTtlMs);
            const pending: Extract<StoredCustomProviderTestReceipt, { state: "pending" }> = {
              state: "pending",
              owner: existing.owner,
              requestId,
              requestFingerprint,
              activeId,
              startedAt: existing.startedAt,
              expiresAt: requestExpiresAt,
            };
            await putWithCommitRecovery(
              input.backing,
              key,
              {
                active: pruned.active,
                receipts: {
                  ...pruned.receipts,
                  [receiptId]: pending,
                },
              },
              (persisted) =>
                sameLease(persisted.active[activeId], existing) &&
                samePendingReceipt(persisted.receipts[receiptId], pending),
            );
          }
          return {
            kind: "running",
            retryAfterMs: existing.expiresAt - claimedAt,
            replayExpected,
            ...(requestExpiresAt === undefined ? {} : { requestExpiresAt }),
          };
        }
        const unresolvedUntil = Object.values(pruned.receipts).reduce(
          (latest, pending) =>
            pending.state === "pending" && pending.activeId === activeId ? Math.max(latest, pending.expiresAt) : latest,
          0,
        );
        if (unresolvedUntil > claimedAt) {
          return {
            kind: "unresolved",
            retryAfterMs: unresolvedUntil - claimedAt,
            requestExpiresAt: unresolvedUntil,
          };
        }
        const owner = ownerId();
        const expiresAt = claimedAt + runningTtlMs;
        const requestExpiresAt = Math.max(expiresAt, claimedAt + resultTtlMs);
        const lease = { owner, requestId, requestFingerprint, startedAt: claimedAt, expiresAt };
        const pending: Extract<StoredCustomProviderTestReceipt, { state: "pending" }> = {
          state: "pending",
          ...lease,
          activeId,
          expiresAt: requestExpiresAt,
        };
        await putWithCommitRecovery(
          input.backing,
          key,
          {
            active: { ...pruned.active, [activeId]: lease },
            receipts: {
              ...pruned.receipts,
              [receiptId]: pending,
            },
          },
          (persisted) =>
            sameLease(persisted.active[activeId], lease) && samePendingReceipt(persisted.receipts[receiptId], pending),
        );
        return {
          kind: "claimed",
          key,
          activeId,
          receiptId,
          owner,
          requestId,
          requestFingerprint,
          expiresAt,
          requestExpiresAt,
        };
      });
    },

    async complete(claim, response) {
      return withRunLock(claim.key, async () => {
        const stored = await input.backing.get(claim.key);
        const lease = stored?.active[claim.activeId];
        const receipt = stored?.receipts[claim.receiptId];
        if (
          !stored ||
          !lease ||
          !receipt ||
          receipt.state !== "pending" ||
          lease.owner !== claim.owner ||
          receipt.owner !== claim.owner ||
          lease.requestId !== claim.requestId ||
          receipt.requestId !== claim.requestId ||
          lease.requestFingerprint !== claim.requestFingerprint ||
          receipt.requestFingerprint !== claim.requestFingerprint ||
          receipt.activeId !== claim.activeId
        ) {
          return false;
        }
        const completedAt = now();
        const active = { ...stored.active };
        delete active[claim.activeId];
        const receipts = { ...stored.receipts };
        for (const [id, pending] of Object.entries(receipts)) {
          if (
            pending.state !== "pending" ||
            pending.owner !== claim.owner ||
            pending.activeId !== claim.activeId ||
            pending.requestFingerprint !== claim.requestFingerprint
          ) {
            continue;
          }
          receipts[id] = {
            state: "completed",
            requestId: pending.requestId,
            requestFingerprint: pending.requestFingerprint,
            response,
            completedAt,
            expiresAt: completedAt + resultTtlMs,
          };
        }
        await input.backing.put(claim.key, {
          active,
          receipts,
        });
        return true;
      });
    },

    async sweep() {
      const expiredAt = now();
      let removed = 0;
      for (const [key] of await input.backing.entries()) {
        removed += await withRunLock(key, async () => {
          const stored = await input.backing.get(key);
          if (!stored) return 0;
          const pruned = pruneExpired(stored, expiredAt);
          if (pruned.removed > 0) await input.backing.put(key, pruned.bucket);
          return pruned.removed;
        });
      }
      return removed;
    },
  };
}
