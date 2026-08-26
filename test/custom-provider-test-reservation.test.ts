import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA,
  CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS,
  signCustomProviderTestReservation,
  type CustomProviderTestReservation,
  verifyCustomProviderTestReservation,
} from "../src/model/custom-provider-test-reservation.ts";

const secret = "current-candidate-reservation-secret-0001";
const now = Date.now();
const unsigned: Omit<CustomProviderTestReservation, "signature"> = {
  schemaVersion: CUSTOM_PROVIDER_TEST_RESERVATION_SCHEMA,
  candidateCommit: "a".repeat(40),
  runAlias: "base-v37",
  budgetRequestId: "admin-pi",
  requestId: `qa-${createHash("sha256")
    .update(`browser:${"a".repeat(40)}:base-v37:admin-pi`)
    .digest("hex")}`,
  orgScope: "org:default-org",
  providerId: "gateway",
  selectionModelId: "gateway/gpt-5.6-luna",
  upstreamModelId: "gpt-5.6-luna",
  harness: "pi" as const,
  protocol: "openai-responses" as const,
  providerRevision: 7,
  createdAt: now,
  expiresAt: now + CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS,
  storageKey: "qm-custom-provider-test-retry:org%3Adefault-org:gateway:gateway%2Fgpt-5.6-luna:pi",
};
const target = {
  candidateCommit: unsigned.candidateCommit,
  orgScope: unsigned.orgScope,
  providerId: unsigned.providerId,
  selectionModelId: unsigned.selectionModelId,
  upstreamModelId: unsigned.upstreamModelId,
  harness: unsigned.harness,
  protocol: unsigned.protocol,
  providerRevision: unsigned.providerRevision,
  requestId: unsigned.requestId,
  storageKey: unsigned.storageKey,
};

test("a signed formal test reservation verifies only for its exact current target", () => {
  const reservation = signCustomProviderTestReservation(unsigned, secret);
  assert.deepEqual(verifyCustomProviderTestReservation(reservation, target, secret, now), reservation);
});

test("formal test reservations reject forgery, old candidates, wrong targets, renewal, and key rollover", () => {
  const reservation = signCustomProviderTestReservation(unsigned, secret);
  const cases = [
    { value: { ...reservation, signature: "0".repeat(64) }, target, key: secret },
    { value: reservation, target: { ...target, candidateCommit: "c".repeat(40) }, key: secret },
    { value: reservation, target: { ...target, orgScope: "org:other" }, key: secret },
    { value: reservation, target: { ...target, harness: "opencode" as const }, key: secret },
    {
      value: { ...reservation, expiresAt: reservation.expiresAt + CUSTOM_PROVIDER_TEST_RESERVATION_TTL_MS },
      target,
      key: secret,
    },
    { value: reservation, target, key: "next-candidate-reservation-secret-00002" },
  ];
  for (const item of cases) {
    assert.equal(verifyCustomProviderTestReservation(item.value, item.target, item.key, now), null);
  }
  assert.equal(verifyCustomProviderTestReservation(reservation, target, secret, reservation.expiresAt), null);
});
