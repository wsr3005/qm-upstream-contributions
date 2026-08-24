import assert from "node:assert/strict";
import { test } from "node:test";
import {
  qaPrincipalCorrelation,
  qaReservationDedupKey,
  signQaReservation,
  verifyQaReservation,
  type QaReservationClaims,
} from "../src/qa-reservation.ts";

const secret = "reservation-secret";
const claims: QaReservationClaims = {
  version: 1,
  requestId: "qa-pi-1",
  runAlias: "base-test-01",
  candidateSha: "a".repeat(40),
  principalCorrelation: qaPrincipalCorrelation(secret, "principal-a"),
  surface: "web",
  threadRef: "web:principal-a:qa",
  conversationKind: "dm",
  harness: "pi",
  model: "gpt-5.6-luna",
  issuedAt: 1_000,
  expiresAt: 61_000,
};

test("QA reservations are signed and principal correlations are stable", () => {
  const token = signQaReservation(claims, secret);
  assert.deepEqual(verifyQaReservation(token, secret), claims);
  assert.equal(qaPrincipalCorrelation(secret, "principal-a"), claims.principalCorrelation);
  assert.notEqual(qaPrincipalCorrelation(secret, "principal-b"), claims.principalCorrelation);
});

test("QA reservation dedupe keys bind every stable product target claim", () => {
  const key = qaReservationDedupKey(claims, secret);
  assert.equal(qaReservationDedupKey({ ...claims, issuedAt: 2_000, expiresAt: 62_000 }, secret), key);
  for (const changed of [
    { ...claims, requestId: "qa-pi-2" },
    { ...claims, runAlias: "base-test-02" },
    { ...claims, candidateSha: "b".repeat(40) },
    { ...claims, principalCorrelation: qaPrincipalCorrelation(secret, "principal-b") },
    { ...claims, threadRef: "web:principal-a:other" },
    { ...claims, conversationKind: "group" as const, channelRef: "group:qa" },
    { ...claims, harness: "codex" as const },
    { ...claims, model: "gpt-5.6-sol" },
  ]) {
    assert.notEqual(qaReservationDedupKey(changed, secret), key);
  }
});

test("QA reservations reject tampering, the wrong secret, extra claims, and long lifetimes", () => {
  const token = signQaReservation(claims, secret);
  assert.equal(verifyQaReservation(`${token}x`, secret), null);
  assert.equal(verifyQaReservation(token, "other-secret"), null);
  assert.throws(() => signQaReservation({ ...claims, extra: true } as QaReservationClaims, secret));
  assert.throws(() => signQaReservation({ ...claims, expiresAt: claims.issuedAt + 300_001 }, secret));
});
