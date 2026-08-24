import { createHmac, timingSafeEqual } from "node:crypto";

export interface QaReservationClaims {
  version: 1;
  requestId: string;
  runAlias: string;
  candidateSha: string;
  principalCorrelation: string;
  surface: "web";
  threadRef: string;
  conversationKind: "dm" | "group" | "channel";
  channelRef?: string;
  harness: "pi" | "opencode" | "codex";
  model: string;
  issuedAt: number;
  expiresAt: number;
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`qm.qa-reservation.v1:${payload}`).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validClaims(value: unknown): value is QaReservationClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort();
  const required = [
    "candidateSha",
    "conversationKind",
    "expiresAt",
    "harness",
    "issuedAt",
    "model",
    "principalCorrelation",
    "requestId",
    "runAlias",
    "surface",
    "threadRef",
    "version",
  ];
  const expected = claims.channelRef === undefined ? required : [...required, "channelRef"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return false;
  return (
    claims.version === 1 &&
    claims.surface === "web" &&
    typeof claims.requestId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(claims.requestId) &&
    typeof claims.runAlias === "string" &&
    /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(claims.runAlias) &&
    typeof claims.candidateSha === "string" &&
    /^[0-9a-f]{40}$/u.test(claims.candidateSha) &&
    typeof claims.principalCorrelation === "string" &&
    /^hmac-[a-f0-9]{16}$/u.test(claims.principalCorrelation) &&
    typeof claims.threadRef === "string" &&
    claims.threadRef.length > 0 &&
    claims.threadRef.length <= 1024 &&
    (claims.conversationKind === "dm" || claims.conversationKind === "group" || claims.conversationKind === "channel") &&
    (claims.channelRef === undefined ||
      (typeof claims.channelRef === "string" && claims.channelRef.length > 0 && claims.channelRef.length <= 1024)) &&
    (claims.harness === "pi" || claims.harness === "opencode" || claims.harness === "codex") &&
    typeof claims.model === "string" &&
    claims.model.length > 0 &&
    claims.model.length <= 200 &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    (claims.expiresAt as number) > (claims.issuedAt as number) &&
    (claims.expiresAt as number) - (claims.issuedAt as number) <= 300_000
  );
}

export function qaPrincipalCorrelation(secret: string, principal: string): string {
  return `hmac-${createHmac("sha256", secret).update(`qm.qa-principal.v1:${principal}`).digest("hex").slice(0, 16)}`;
}

export function qaReservationDedupKey(claims: QaReservationClaims, secret: string): string {
  if (!secret || !validClaims(claims)) throw new Error("invalid QA reservation claims");
  const identity = JSON.stringify({
    version: claims.version,
    requestId: claims.requestId,
    runAlias: claims.runAlias,
    candidateSha: claims.candidateSha,
    principalCorrelation: claims.principalCorrelation,
    surface: claims.surface,
    threadRef: claims.threadRef,
    conversationKind: claims.conversationKind,
    channelRef: claims.channelRef ?? null,
    harness: claims.harness,
    model: claims.model,
  });
  return `web-qa-reservation:${createHmac("sha256", secret).update(identity).digest("base64url")}`;
}

export function signQaReservation(claims: QaReservationClaims, secret: string): string {
  if (!secret || !validClaims(claims)) throw new Error("invalid QA reservation claims");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyQaReservation(token: string, secret: string): QaReservationClaims | null {
  if (!token || !secret) return null;
  const [payload, got, extra] = token.split(".");
  if (!payload || !got || extra !== undefined || !safeEqual(got, signature(secret, payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return validClaims(claims) ? claims : null;
  } catch {
    return null;
  }
}
