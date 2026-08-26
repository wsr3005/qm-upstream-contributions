export interface ProductReservation {
  schemaVersion: "qm-model-test-product-reservation-v2";
  runAlias: string;
  candidateCommit: string;
  requestId: string;
  harness: string;
  model: string;
  upstreamModelId: string;
  modelProviderId: string;
  modelProviderRevision: number;
  idempotencyKey: string;
  principalCorrelation: string;
}

const FIELDS = [
  "schemaVersion",
  "runAlias",
  "candidateCommit",
  "requestId",
  "harness",
  "model",
  "upstreamModelId",
  "modelProviderId",
  "modelProviderRevision",
  "idempotencyKey",
  "principalCorrelation",
] as const;

const text = (value: Record<string, unknown>, key: (typeof FIELDS)[number]): string => {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`Reservation ${key} is invalid.`);
  return field;
};

export function parseProductReservation(input: string): ProductReservation {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Reservation must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reservation must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== FIELDS.length || FIELDS.some((field) => !(field in record))) {
    throw new Error("Reservation fields do not match the product reservation contract.");
  }
  const schemaVersion = text(record, "schemaVersion");
  const runAlias = text(record, "runAlias");
  const candidateCommit = text(record, "candidateCommit");
  const requestId = text(record, "requestId");
  const harness = text(record, "harness");
  const model = text(record, "model");
  const upstreamModelId = text(record, "upstreamModelId");
  const modelProviderId = text(record, "modelProviderId");
  const idempotencyKey = text(record, "idempotencyKey");
  const principalCorrelation = text(record, "principalCorrelation");
  const modelProviderRevision = record.modelProviderRevision;
  if (schemaVersion !== "qm-model-test-product-reservation-v2") throw new Error("Reservation schema is unsupported.");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(runAlias)) throw new Error("Reservation run alias is invalid.");
  if (!/^[a-f0-9]{40}$/u.test(candidateCommit)) throw new Error("Reservation candidate is invalid.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)) throw new Error("Reservation request is invalid.");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(modelProviderId)) throw new Error("Reservation Provider is invalid.");
  if (!Number.isSafeInteger(modelProviderRevision) || Number(modelProviderRevision) <= 0) {
    throw new Error("Reservation Provider revision is invalid.");
  }
  if (!/^qa-[a-f0-9]{64}$/u.test(idempotencyKey)) throw new Error("Reservation idempotency key is invalid.");
  if (!/^hmac-[a-f0-9]{16}$/u.test(principalCorrelation)) {
    throw new Error("Reservation Principal correlation is invalid.");
  }
  if (model !== `${modelProviderId}/${upstreamModelId}`) throw new Error("Reservation model identity is inconsistent.");
  return {
    schemaVersion,
    runAlias,
    candidateCommit,
    requestId,
    harness,
    model,
    upstreamModelId,
    modelProviderId,
    modelProviderRevision: Number(modelProviderRevision),
    idempotencyKey,
    principalCorrelation,
  };
}

export function assertProductReservationTarget(
  reservation: ProductReservation,
  target: { harness: string; model: string },
): void {
  if (reservation.harness !== target.harness) throw new Error("Reservation Harness does not match the composer.");
  if (reservation.model !== target.model) throw new Error("Reservation model does not match the composer.");
}
