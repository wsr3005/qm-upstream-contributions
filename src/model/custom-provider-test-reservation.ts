import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CUSTOM_PROVIDER_PROTOCOLS, type CustomProviderProtocol } from "./custom-providers.ts";
import type { CustomProviderTestHarness } from "../api/deps.ts";

export const CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA = "qm-model-test-browser-receipt-v3";
export const CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS = 5 * 60_000;

const COMMIT = /^[a-f0-9]{40}$/;
const RUN_ALIAS = /^[a-z0-9][a-z0-9-]{0,79}$/;
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BOUND_REQUEST = /^qa-[a-f0-9]{64}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const HARNESSES = new Set<CustomProviderTestHarness>(["pi", "opencode", "codex"]);
const RESERVATION_KEYS = [
  "budgetRequestId",
  "candidateCommit",
  "createdAt",
  "expiresAt",
  "harness",
  "orgScope",
  "protocol",
  "providerId",
  "providerRevision",
  "requestId",
  "runAlias",
  "schemaVersion",
  "selectionModelId",
  "signature",
  "storageKey",
  "upstreamModelId",
];

export interface CustomProviderTestReservation {
  schemaVersion: typeof CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA;
  candidateCommit: string;
  runAlias: string;
  budgetRequestId: string;
  requestId: string;
  orgScope: string;
  providerId: string;
  selectionModelId: string;
  upstreamModelId: string;
  harness: CustomProviderTestHarness;
  protocol: CustomProviderProtocol;
  providerRevision: number;
  createdAt: number;
  expiresAt: number;
  storageKey: string;
  signature: string;
}

export interface CustomProviderTestReservationTarget {
  candidateCommit: string;
  orgScope: string;
  providerId: string;
  selectionModelId: string;
  upstreamModelId: string;
  harness: CustomProviderTestHarness;
  protocol: CustomProviderProtocol;
  providerRevision: number;
  requestId: string;
  storageKey: string;
}

export function customProviderTestReservationPayload(
  reservation: Omit<CustomProviderTestReservation, "signature">,
): string {
  return JSON.stringify([
    reservation.schemaVersion,
    reservation.candidateCommit,
    reservation.runAlias,
    reservation.budgetRequestId,
    reservation.requestId,
    reservation.orgScope,
    reservation.providerId,
    reservation.selectionModelId,
    reservation.upstreamModelId,
    reservation.harness,
    reservation.protocol,
    reservation.providerRevision,
    reservation.createdAt,
    reservation.expiresAt,
    reservation.storageKey,
  ]);
}

export function signCustomProviderTestReservation(
  reservation: Omit<CustomProviderTestReservation, "signature">,
  secret: string,
): CustomProviderTestReservation {
  const signature = createHmac("sha256", secret)
    .update(customProviderTestReservationPayload(reservation))
    .digest("hex");
  return { ...reservation, signature };
}

export function parseCustomProviderTestReservation(value: unknown): CustomProviderTestReservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reservation = value as Partial<CustomProviderTestReservation>;
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RESERVATION_KEYS) ||
    reservation.schemaVersion !== CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA ||
    !COMMIT.test(reservation.candidateCommit ?? "") ||
    !RUN_ALIAS.test(reservation.runAlias ?? "") ||
    !REQUEST.test(reservation.budgetRequestId ?? "") ||
    !BOUND_REQUEST.test(reservation.requestId ?? "") ||
    typeof reservation.orgScope !== "string" ||
    !reservation.orgScope ||
    typeof reservation.providerId !== "string" ||
    !reservation.providerId ||
    typeof reservation.selectionModelId !== "string" ||
    !reservation.selectionModelId ||
    typeof reservation.upstreamModelId !== "string" ||
    !reservation.upstreamModelId ||
    !HARNESSES.has(reservation.harness as CustomProviderTestHarness) ||
    !(CUSTOM_PROVIDER_PROTOCOLS as readonly unknown[]).includes(reservation.protocol) ||
    !Number.isSafeInteger(reservation.providerRevision) ||
    reservation.providerRevision! < 1 ||
    !Number.isSafeInteger(reservation.createdAt) ||
    !Number.isSafeInteger(reservation.expiresAt) ||
    typeof reservation.storageKey !== "string" ||
    !reservation.storageKey ||
    !SIGNATURE.test(reservation.signature ?? "")
  ) {
    return null;
  }
  return reservation as CustomProviderTestReservation;
}

export function verifyCustomProviderTestReservation(
  value: unknown,
  target: CustomProviderTestReservationTarget,
  secret: string,
  now = Date.now(),
): CustomProviderTestReservation | null {
  const reservation = parseCustomProviderTestReservation(value);
  if (!reservation || secret.length < 32) return null;
  const { signature, ...unsigned } = reservation;
  const expected = createHmac("sha256", secret).update(customProviderTestReservationPayload(unsigned)).digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const expectedRequestId = `qa-${createHash("sha256")
    .update(`browser:${reservation.candidateCommit}:${reservation.runAlias}:${reservation.budgetRequestId}`)
    .digest("hex")}`;
  if (
    reservation.requestId !== expectedRequestId ||
    reservation.createdAt > now ||
    reservation.expiresAt <= now ||
    reservation.expiresAt - reservation.createdAt !== CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS ||
    reservation.candidateCommit !== target.candidateCommit ||
    reservation.orgScope !== target.orgScope ||
    reservation.providerId !== target.providerId ||
    reservation.selectionModelId !== target.selectionModelId ||
    reservation.upstreamModelId !== target.upstreamModelId ||
    reservation.harness !== target.harness ||
    reservation.protocol !== target.protocol ||
    reservation.providerRevision !== target.providerRevision ||
    reservation.requestId !== target.requestId ||
    reservation.storageKey !== target.storageKey
  ) {
    return null;
  }
  return reservation;
}

export function customProviderTestReservationFingerprint(reservation: CustomProviderTestReservation): string {
  return createHmac("sha256", reservation.signature)
    .update(customProviderTestReservationPayload(reservation))
    .digest("hex");
}
