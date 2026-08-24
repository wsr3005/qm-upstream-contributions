/**
 * Durable, encrypted storage for custom model providers.
 *
 * Mirrors model-credential-store: specs live in a DurableMap, API keys
 * are encrypted at rest with a key derived from the connector secret,
 * and the store never hands the plaintext key to anything but the
 * per-call resolver.
 */

import { createHmac } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { errMessage } from "../util/errors.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

export const CUSTOM_PROVIDER_WIRE_ID_SCHEMA = 1;
export const CUSTOM_PROVIDER_WIRE_ID_CAPABILITY = "custom-provider-wire-id-v1";
export const CUSTOM_PROVIDER_INPUT_MODALITIES_SCHEMA = 2;
export const CUSTOM_PROVIDER_INPUT_MODALITIES_CAPABILITY = "custom-provider-input-modalities-v2";
export const CUSTOM_PROVIDER_PUBLICATION_SCHEMA = 3;
export const CUSTOM_PROVIDER_PUBLICATION_CAPABILITY = "custom-provider-publication-v3";
export const CUSTOM_PROVIDER_HARNESS_TEST_CAPABILITY = "custom-provider-harness-test-v2";

export class CustomProviderRuntimeNotReadyError extends Error {}

export interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  published?: boolean;
  compatibilityDisabled?: boolean;
  runtimeSchema?: number;
  modelHistory?: string[];
  verifiedTargets?: Array<{ modelId: string; harnessId: string; revision: number; testedAt: number }>;
  revision?: number;
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  testable: boolean;
  published: boolean;
  hasKey: boolean;
  revision: number;
  verifiedTargets: Array<{ modelId: string; harnessId: string; revision: number; testedAt: number }>;
  updatedAt: number;
  updatedBy: string;
}

export interface ActiveCustomProvider {
  provider: CustomProviderSpec;
  apiKey: string | null;
  revision: number;
}

export interface CustomProviderHarnessTestState {
  active: ActiveCustomProvider | null;
  rolloutFence: string | null;
}

export interface CustomProviderStore {
  /** Enabled specs only — what the runtime registry should serve. */
  enabled(): Promise<CustomProviderSpec[]>;
  /** Everything, for the admin surface (no secrets). */
  statuses(): Promise<CustomProviderStatus[]>;
  /** Plaintext key for one provider, or null when absent/disabled. */
  resolveKey(id: string): Promise<string | null>;
  resolveActive(id: string): Promise<ActiveCustomProvider | null>;
  resolveTestable(id: string): Promise<ActiveCustomProvider | null>;
  harnessTestState(id: string, readRolloutFence: () => Promise<string | null>): Promise<CustomProviderHarnessTestState>;
  testableHarnessState(
    id: string,
    readRolloutFence: () => Promise<string | null>,
  ): Promise<CustomProviderHarnessTestState>;
  recordVerification(
    id: string,
    revision: number,
    modelId: string,
    harnessId: string,
    testedAt: number,
  ): Promise<boolean>;
  publish(
    id: string,
    revision: number,
    requiredTargets: Array<{ modelId: string; harnessId: string }>,
    updatedBy: string,
  ): Promise<boolean>;
  active(): Promise<Array<{ provider: CustomProviderSpec; apiKey: string | null }>>;
  knowsModel(id: string): Promise<boolean>;
  knownModelIds(): Promise<string[]>;
  runtimeSchemaReady(schema: number): Promise<boolean>;
  runtimeSchemaWritable(schema: number): Promise<boolean>;
  fingerprintSensitive(value: string): string;
  upsert(
    spec: CustomProviderSpec,
    apiKey: string | undefined,
    updatedBy: string,
    options?: { stage?: boolean },
  ): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

function strip(saved: StoredCustomProvider): CustomProviderSpec {
  return {
    id: saved.id,
    name: saved.name,
    protocol: saved.protocol,
    baseUrl: saved.baseUrl,
    models: saved.models.map((model) => {
      if ((saved.runtimeSchema ?? 0) >= CUSTOM_PROVIDER_INPUT_MODALITIES_SCHEMA) return model;
      const legacyModel = { ...model };
      delete legacyModel.inputModalities;
      return legacyModel;
    }),
  };
}

export function requiredCustomProviderRuntimeSchema(spec: CustomProviderSpec): number | undefined {
  if (spec.models.some((model) => model.inputModalities !== undefined)) {
    return CUSTOM_PROVIDER_INPUT_MODALITIES_SCHEMA;
  }
  if (spec.models.some((model) => model.upstreamId !== undefined)) return CUSTOM_PROVIDER_WIRE_ID_SCHEMA;
  return undefined;
}

export function createCustomProviderStore(input: {
  backing: DurableMap<StoredCustomProvider>;
  keyMaterial: string | Buffer;
  advisoryLock?: AdvisoryLock;
  runtimeSchemaReady?: (schema: number) => Promise<boolean>;
  runtimeSchemaWritable?: (schema: number) => Promise<boolean>;
}): CustomProviderStore {
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");
  const withRegistryLock = <T>(operation: () => Promise<T>): Promise<T> =>
    input.advisoryLock ? input.advisoryLock.withLock("custom-model-providers", operation) : operation();
  const knownRuntimeSchema = (schema: number): boolean =>
    schema === CUSTOM_PROVIDER_WIRE_ID_SCHEMA ||
    schema === CUSTOM_PROVIDER_INPUT_MODALITIES_SCHEMA ||
    schema === CUSTOM_PROVIDER_PUBLICATION_SCHEMA;
  const runtimeSchemaReady = (schema: number): Promise<boolean> =>
    knownRuntimeSchema(schema) ? (input.runtimeSchemaReady?.(schema) ?? Promise.resolve(true)) : Promise.resolve(false);
  const runtimeSchemaWritable = (schema: number): Promise<boolean> =>
    knownRuntimeSchema(schema)
      ? (input.runtimeSchemaWritable?.(schema) ?? runtimeSchemaReady(schema))
      : Promise.resolve(false);
  const compatibilityEncoded = (saved: StoredCustomProvider): boolean =>
    saved.runtimeSchema !== undefined &&
    knownRuntimeSchema(saved.runtimeSchema) &&
    saved.compatibilityDisabled === true &&
    saved.disabled === true;
  const explicitlyDisabled = (saved: StoredCustomProvider): boolean =>
    saved.disabled === true && !compatibilityEncoded(saved);
  const runtimeEnabled = (saved: StoredCustomProvider, readySchemas: ReadonlySet<number>): boolean => {
    if (saved.runtimeSchema === CUSTOM_PROVIDER_PUBLICATION_SCHEMA && saved.published !== true) return false;
    if (explicitlyDisabled(saved)) return false;
    if (saved.runtimeSchema === undefined) return true;
    return compatibilityEncoded(saved) && readySchemas.has(saved.runtimeSchema);
  };
  const readySchemas = async (saved: StoredCustomProvider[]): Promise<ReadonlySet<number>> => {
    const schemas = [...new Set(saved.flatMap((provider) => provider.runtimeSchema ?? []))];
    const readiness = await Promise.all(
      schemas.map(async (schema) => [schema, await runtimeSchemaReady(schema)] as const),
    );
    return new Set(readiness.filter(([, ready]) => ready).map(([schema]) => schema));
  };
  const resolveActive = async (id: string): Promise<ActiveCustomProvider | null> => {
    const saved = await input.backing.get(id);
    if (!saved || !runtimeEnabled(saved, await readySchemas([saved]))) return null;
    return {
      provider: strip(saved),
      apiKey: saved.apiKeyEnc ? decryptSecret(saved.apiKeyEnc, key) : null,
      revision: saved.revision ?? 0,
    };
  };
  const resolveTestable = async (id: string): Promise<ActiveCustomProvider | null> => {
    const saved = await input.backing.get(id);
    if (!saved || explicitlyDisabled(saved)) return null;
    const ready = await readySchemas([saved]);
    if (saved.runtimeSchema !== undefined && !ready.has(saved.runtimeSchema)) return null;
    return {
      provider: strip(saved),
      apiKey: saved.apiKeyEnc ? decryptSecret(saved.apiKeyEnc, key) : null,
      revision: saved.revision ?? 0,
    };
  };

  return {
    async enabled() {
      const all = await input.backing.all();
      const ready = await readySchemas(all);
      return all.filter((saved) => runtimeEnabled(saved, ready)).map(strip);
    },

    async statuses() {
      const all = await input.backing.all();
      const ready = await readySchemas(all);
      return all
        .map((p) => ({
          ...strip(p),
          disabled: !runtimeEnabled(p, ready),
          testable: !explicitlyDisabled(p) && (p.runtimeSchema === undefined || ready.has(p.runtimeSchema)),
          published: p.runtimeSchema !== CUSTOM_PROVIDER_PUBLICATION_SCHEMA || p.published === true,
          hasKey: Boolean(p.apiKeyEnc),
          revision: p.revision ?? 0,
          verifiedTargets: p.verifiedTargets ?? [],
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id) {
      const saved = await input.backing.get(id);
      if (!saved || !runtimeEnabled(saved, await readySchemas([saved])) || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    resolveActive,
    resolveTestable,

    async harnessTestState(id, readRolloutFence) {
      const before = await readRolloutFence();
      return withRegistryLock(async () => {
        const active = await resolveActive(id);
        const after = await readRolloutFence();
        return {
          active,
          rolloutFence: before !== null && before === after ? before : null,
        };
      });
    },

    async testableHarnessState(id, readRolloutFence) {
      const before = await readRolloutFence();
      return withRegistryLock(async () => {
        const active = await resolveTestable(id);
        const after = await readRolloutFence();
        return {
          active,
          rolloutFence: before !== null && before === after ? before : null,
        };
      });
    },

    async recordVerification(id, revision, modelId, harnessId, testedAt) {
      return withRegistryLock(async () => {
        const saved = await input.backing.get(id);
        if (
          !saved ||
          explicitlyDisabled(saved) ||
          saved.runtimeSchema !== CUSTOM_PROVIDER_PUBLICATION_SCHEMA ||
          (saved.revision ?? 0) !== revision
        )
          return false;
        const verifiedTargets = (saved.verifiedTargets ?? []).filter(
          (target) => !(target.revision === revision && target.modelId === modelId && target.harnessId === harnessId),
        );
        verifiedTargets.push({ modelId, harnessId, revision, testedAt });
        await input.backing.put(id, { ...saved, verifiedTargets });
        return true;
      });
    },

    async publish(id, revision, requiredTargets, updatedBy) {
      return withRegistryLock(async () => {
        const saved = await input.backing.get(id);
        if (
          !saved ||
          explicitlyDisabled(saved) ||
          saved.runtimeSchema !== CUSTOM_PROVIDER_PUBLICATION_SCHEMA ||
          (saved.revision ?? 0) !== revision
        )
          return false;
        const verified = new Set(
          (saved.verifiedTargets ?? [])
            .filter((target) => target.revision === revision)
            .map((target) => `${target.modelId}:${target.harnessId}`),
        );
        if (requiredTargets.some((target) => !verified.has(`${target.modelId}:${target.harnessId}`))) return false;
        await input.backing.put(id, {
          ...saved,
          published: true,
          updatedAt: Date.now(),
          updatedBy,
        });
        return true;
      });
    },

    async active() {
      const all = await input.backing.all();
      const ready = await readySchemas(all);
      return all
        .filter((saved) => runtimeEnabled(saved, ready))
        .map((saved) => ({
          provider: strip(saved),
          apiKey: (() => {
            if (!saved.apiKeyEnc) return null;
            try {
              return decryptSecret(saved.apiKeyEnc, key);
            } catch (error) {
              console.error(`[model] custom provider ${saved.id}: key unreadable: ${errMessage(error)}`);
              return null;
            }
          })(),
        }));
    },

    async knowsModel(id) {
      const all = await input.backing.all();
      return all.some((saved) => saved.models.some((model) => model.id === id) || saved.modelHistory?.includes(id));
    },

    async knownModelIds() {
      const all = await input.backing.all();
      return [
        ...new Set(all.flatMap((saved) => [...saved.models.map((model) => model.id), ...(saved.modelHistory ?? [])])),
      ];
    },

    runtimeSchemaReady,

    runtimeSchemaWritable,

    fingerprintSensitive(value) {
      return createHmac("sha256", key.current).update(value).digest("hex");
    },

    async upsert(spec, apiKey, updatedBy, options) {
      await withRegistryLock(async () => {
        validateCustomProviderSpec(spec);
        const existing = await input.backing.get(spec.id);
        const requiredSchema = requiredCustomProviderRuntimeSchema(spec);
        const protectedSchema =
          existing?.runtimeSchema ??
          (existing?.compatibilityDisabled === true ? CUSTOM_PROVIDER_WIRE_ID_SCHEMA : undefined);
        const runtimeSchema =
          Math.max(
            protectedSchema ?? 0,
            requiredSchema ?? 0,
            options?.stage === true ? CUSTOM_PROVIDER_PUBLICATION_SCHEMA : 0,
          ) || undefined;
        if (runtimeSchema !== undefined && !(await runtimeSchemaWritable(runtimeSchema))) {
          throw new CustomProviderRuntimeNotReadyError(
            "custom model configuration is unavailable until the compatibility rollout is complete",
          );
        }
        const conflict = (await input.backing.all()).find(
          (saved) =>
            !explicitlyDisabled(saved) &&
            saved.id !== spec.id &&
            saved.models.some((model) => spec.models.some((candidate) => candidate.id === model.id)),
        );
        if (conflict) throw new Error(`custom model id is already registered by provider "${conflict.id}"`);
        const actor = updatedBy.trim();
        if (!actor) throw new Error("updatedBy is required");
        const trimmedKey = apiKey?.trim();
        const apiKeyEnc = trimmedKey ? encryptSecret(trimmedKey, key) : existing?.apiKeyEnc;
        const modelHistory = [
          ...new Set([
            ...(existing?.modelHistory ?? []),
            ...(existing?.models ?? []).map((model) => model.id),
            ...spec.models.map((model) => model.id),
          ]),
        ];
        await input.backing.put(spec.id, {
          ...spec,
          ...(apiKeyEnc ? { apiKeyEnc } : {}),
          modelHistory,
          ...(runtimeSchema === CUSTOM_PROVIDER_PUBLICATION_SCHEMA
            ? { published: options?.stage === true ? false : true }
            : {}),
          verifiedTargets: [],
          ...(runtimeSchema !== undefined
            ? { runtimeSchema, compatibilityDisabled: true, disabled: true }
            : { compatibilityDisabled: false, disabled: false }),
          revision: (existing?.revision ?? 0) + 1,
          updatedAt: Date.now(),
          updatedBy: actor,
        });
      });
    },

    async delete(id, updatedBy) {
      return withRegistryLock(async () => {
        const existing = await input.backing.get(id);
        if (!existing || explicitlyDisabled(existing)) return false;
        await input.backing.put(id, {
          ...existing,
          disabled: true,
          compatibilityDisabled: false,
          revision: (existing.revision ?? 0) + 1,
          updatedAt: Date.now(),
          updatedBy,
        });
        return true;
      });
    },
  };
}
