import { randomUUID } from "node:crypto";
import type { Delivery, DeliveryProvenance, DeliveryResolution, Destination, OutgoingAttachment } from "../types.ts";
import { cronIdOf } from "../sessions/session-store.ts";

export interface DeliveryStore {
  enqueue(input: {
    destination: Destination;
    text: string;
    attachments?: OutgoingAttachment[];
    provenance?: DeliveryProvenance;
    idempotencyKey: string;
    shadow?: boolean;
  }): Promise<Delivery>;
  pending(type: string): Promise<Delivery[]>;
  claimPending(type: string, ttlMs: number): Promise<Delivery[]>;
  renewClaim(id: string, token: string, ttlMs: number): Promise<boolean>;
  resolveClaim(id: string, token: string, resolution: DeliveryResolution): Promise<"resolved" | "duplicate" | "stale">;
  listShadow(opts?: { limit?: number }): Promise<Delivery[]>;
  ack(id: string, at: number, slackApiMs?: number): Promise<void>;
  ackByKey(idempotencyKey: string, at: number): Promise<void>;
  setEditRefByKey(idempotencyKey: string, editRef: string): Promise<void>;
  get(id: string): Promise<Delivery | null>;
  recordRecipientThread(id: string, recipientThreadRef: string, at: number): Promise<void>;
  listByRecipientThread(recipientThreadRef: string, opts?: { limit?: number }): Promise<Delivery[]>;
  listBySourceSession(sourceSessionId: string, sourceThreadRef: string, opts?: { limit?: number }): Promise<Delivery[]>;
  sentCountsBySourceSessions(sources: Array<{ sessionId: string; threadRef: string }>): Promise<Map<string, number>>;
  sentRunCountsByCron(cronIds: string[]): Promise<Map<string, number>>;
  onEnqueue(listener: () => void): () => void;
}

export function createDeliveryStore(): DeliveryStore {
  const deliveries = new Map<string, Delivery>();
  const byKey = new Map<string, string>();
  const claims = new Map<string, { token: string; expiresAt: number }>();
  const enqueueListeners = new Set<() => void>();

  return {
    async enqueue(input) {
      const existingId = byKey.get(input.idempotencyKey);
      if (existingId) return deliveries.get(existingId)!;
      const delivery: Delivery = {
        id: randomUUID(),
        destination: input.destination,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
        idempotencyKey: input.idempotencyKey,
        createdAt: Date.now(),
        deliveredAt: null,
        ...(input.shadow ? { shadow: true } : {}),
      };
      deliveries.set(delivery.id, delivery);
      byKey.set(delivery.idempotencyKey, delivery.id);
      if (!delivery.shadow) for (const l of enqueueListeners) l();
      return delivery;
    },
    async pending(type) {
      return [...deliveries.values()].filter(
        (d) => d.deliveredAt === null && d.failure === undefined && !d.shadow && d.destination.type === type,
      );
    },
    async claimPending(type, ttlMs) {
      const now = Date.now();
      const rows = [...deliveries.values()].filter(
        (d) =>
          d.deliveredAt === null &&
          d.failure === undefined &&
          !d.shadow &&
          d.destination.type === type &&
          (claims.get(d.id)?.expiresAt ?? 0) <= now,
      );
      return rows.map((delivery) => {
        const claim = { token: randomUUID(), expiresAt: now + ttlMs };
        claims.set(delivery.id, claim);
        return { ...delivery, claim: { token: claim.token, expiresAt: claim.expiresAt } };
      });
    },
    async renewClaim(id, token, ttlMs) {
      const delivery = deliveries.get(id);
      const claim = claims.get(id);
      const now = Date.now();
      if (!delivery || delivery.deliveredAt !== null || delivery.failure !== undefined) return false;
      if (!claim || claim.token !== token || claim.expiresAt <= now) return false;
      claim.expiresAt = now + ttlMs;
      return true;
    },
    async resolveClaim(id, token, resolution) {
      const delivery = deliveries.get(id);
      const claim = claims.get(id);
      if (!delivery || !claim || claim.token !== token) return "stale";
      if (delivery.deliveredAt !== null) return resolution.kind === "delivered" ? "duplicate" : "stale";
      if (delivery.failure !== undefined) {
        return resolution.kind === "failed" && delivery.failure.code === resolution.code ? "duplicate" : "stale";
      }
      if (claim.expiresAt <= Date.now()) return "stale";
      if (resolution.kind === "delivered") {
        delivery.deliveredAt = resolution.at;
        delivery.deliverLatencyMs = Math.max(0, resolution.at - delivery.createdAt);
      } else {
        delivery.failure = { at: resolution.at, code: resolution.code };
      }
      return "resolved";
    },
    async listShadow(opts) {
      const limit = Math.max(1, opts?.limit ?? 100);
      return [...deliveries.values()]
        .filter((d) => d.shadow && d.deliveredAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async ack(id, at, slackApiMs) {
      const d = deliveries.get(id);
      if (d && d.deliveredAt === null && d.failure === undefined) {
        d.deliveredAt = at;
        d.deliverLatencyMs = Math.max(0, at - d.createdAt);
        if (slackApiMs !== undefined) d.slackApiMs = slackApiMs;
      }
    },
    async ackByKey(idempotencyKey, at) {
      const existingId = byKey.get(idempotencyKey);
      if (existingId) {
        const d = deliveries.get(existingId);
        if (d && d.deliveredAt === null && d.failure === undefined) d.deliveredAt = at;
        return;
      }
      const tombstone: Delivery = {
        id: randomUUID(),
        destination: { type: "ack-tombstone", target: "" },
        text: "",
        idempotencyKey,
        createdAt: at,
        deliveredAt: at,
      };
      deliveries.set(tombstone.id, tombstone);
      byKey.set(idempotencyKey, tombstone.id);
    },
    async setEditRefByKey(idempotencyKey, editRef) {
      const existingId = byKey.get(idempotencyKey);
      const d = existingId ? deliveries.get(existingId) : undefined;
      if (d && d.deliveredAt === null) d.destination = { ...d.destination, editRef };
    },
    async get(id) {
      return deliveries.get(id) ?? null;
    },
    async recordRecipientThread(id, recipientThreadRef, at) {
      const d = deliveries.get(id);
      if (!d || d.destination.type !== "principal" || d.failure !== undefined) return;
      d.recipientThreadRef = recipientThreadRef;
      if (d.deliveredAt === null) d.deliveredAt = at;
    },
    async listByRecipientThread(recipientThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      return [...deliveries.values()]
        .filter((d) => d.recipientThreadRef === recipientThreadRef && d.destination.type === "principal")
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    },
    async listBySourceSession(sourceSessionId, sourceThreadRef, opts) {
      const limit = Math.max(1, opts?.limit ?? 20);
      return [...deliveries.values()]
        .filter(
          (d) => d.provenance?.sourceSessionId === sourceSessionId || d.provenance?.sourceThreadRef === sourceThreadRef,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-limit);
    },
    async sentCountsBySourceSessions(sources) {
      const counts = new Map<string, number>();
      const byId = new Set(sources.map((s) => s.sessionId));
      const byThreadRef = new Map(sources.map((s) => [s.threadRef, s.sessionId]));
      for (const d of deliveries.values()) {
        if (d.shadow || !d.provenance) continue;
        let id: string | undefined;
        if (d.provenance.sourceSessionId) {
          if (byId.has(d.provenance.sourceSessionId)) id = d.provenance.sourceSessionId;
        } else if (d.provenance.sourceThreadRef) {
          id = byThreadRef.get(d.provenance.sourceThreadRef);
        }
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    },
    async sentRunCountsByCron(cronIds) {
      const wanted = new Set(cronIds);
      const runs = new Map<string, Set<string>>();
      for (const d of deliveries.values()) {
        if (d.shadow || !d.provenance?.sourceThreadRef) continue;
        const cronId = cronIdOf(d.provenance.sourceThreadRef);
        if (!cronId || !wanted.has(cronId)) continue;
        let set = runs.get(cronId);
        if (!set) runs.set(cronId, (set = new Set()));
        set.add(d.provenance.sourceSessionId ?? d.provenance.sourceThreadRef);
      }
      return new Map([...runs].map(([k, v]) => [k, v.size]));
    },
    onEnqueue(listener) {
      enqueueListeners.add(listener);
      return () => enqueueListeners.delete(listener);
    },
  };
}
