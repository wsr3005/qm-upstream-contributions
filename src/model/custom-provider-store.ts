/**
 * Durable, encrypted storage for custom model providers.
 *
 * Mirrors model-credential-store: specs live in a DurableMap, API keys
 * are encrypted at rest with a key derived from the connector secret,
 * and the store never hands the plaintext key to anything but the
 * per-call resolver.
 */

import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { errMessage } from "../util/errors.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

export const CUSTOM_PROVIDER_WIRE_ID_SCHEMA = 1;
export const CUSTOM_PROVIDER_WIRE_ID_CAPABILITY = "custom-provider-wire-id-v1";
export const CUSTOM_PROVIDER_HARNESS_TEST_CAPABILITY = "custom-provider-harness-test-v2";

export class CustomProviderRuntimeNotReadyError extends Error {}

export interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  compatibilityDisabled?: boolean;
  runtimeSchema?: number;
  modelHistory?: string[];
  revision?: number;
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  hasKey: boolean;
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
  harnessTestState(id: string, readRolloutFence: () => Promise<string | null>): Promise<CustomProviderHarnessTestState>;
  active(): Promise<Array<{ provider: CustomProviderSpec; apiKey: string | null }>>;
  knowsModel(id: string): Promise<boolean>;
  knownModelIds(): Promise<string[]>;
  runtimeSchemaReady(schema: number): Promise<boolean>;
  runtimeSchemaWritable(schema: number): Promise<boolean>;
  upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

function strip(saved: StoredCustomProvider): CustomProviderSpec {
  return {
    id: saved.id,
    name: saved.name,
    protocol: saved.protocol,
    baseUrl: saved.baseUrl,
    models: saved.models,
  };
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
  const runtimeSchemaReady = (schema: number): Promise<boolean> =>
    schema === CUSTOM_PROVIDER_WIRE_ID_SCHEMA
      ? (input.runtimeSchemaReady?.(schema) ?? Promise.resolve(true))
      : Promise.resolve(false);
  const runtimeSchemaWritable = (schema: number): Promise<boolean> =>
    schema === CUSTOM_PROVIDER_WIRE_ID_SCHEMA
      ? (input.runtimeSchemaWritable?.(schema) ?? runtimeSchemaReady(schema))
      : Promise.resolve(false);
  const compatibilityEncoded = (saved: StoredCustomProvider): boolean =>
    saved.runtimeSchema === CUSTOM_PROVIDER_WIRE_ID_SCHEMA &&
    saved.compatibilityDisabled === true &&
    saved.disabled === true;
  const explicitlyDisabled = (saved: StoredCustomProvider): boolean =>
    saved.disabled === true && !compatibilityEncoded(saved);
  const runtimeEnabled = (saved: StoredCustomProvider, wireIdReady: boolean): boolean => {
    if (explicitlyDisabled(saved)) return false;
    if (saved.runtimeSchema === undefined) return true;
    return compatibilityEncoded(saved) && wireIdReady;
  };
  const wireIdReady = (): Promise<boolean> => runtimeSchemaReady(CUSTOM_PROVIDER_WIRE_ID_SCHEMA);
  const resolveActive = async (id: string): Promise<ActiveCustomProvider | null> => {
    const saved = await input.backing.get(id);
    if (!saved || !runtimeEnabled(saved, await wireIdReady())) return null;
    return {
      provider: strip(saved),
      apiKey: saved.apiKeyEnc ? decryptSecret(saved.apiKeyEnc, key) : null,
      revision: saved.revision ?? 0,
    };
  };

  return {
    async enabled() {
      const all = await input.backing.all();
      const ready = await wireIdReady();
      return all.filter((saved) => runtimeEnabled(saved, ready)).map(strip);
    },

    async statuses() {
      const all = await input.backing.all();
      const ready = await wireIdReady();
      return all
        .map((p) => ({
          ...strip(p),
          disabled: !runtimeEnabled(p, ready),
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id) {
      const saved = await input.backing.get(id);
      if (!saved || !runtimeEnabled(saved, await wireIdReady()) || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    resolveActive,

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

    async active() {
      const all = await input.backing.all();
      const ready = await wireIdReady();
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

    async upsert(spec, apiKey, updatedBy) {
      await withRegistryLock(async () => {
        validateCustomProviderSpec(spec);
        const existing = await input.backing.get(spec.id);
        const runtimeSchema = spec.models.some((model) => model.upstreamId !== undefined)
          ? CUSTOM_PROVIDER_WIRE_ID_SCHEMA
          : undefined;
        const protectedSchema =
          existing?.runtimeSchema ??
          (existing?.compatibilityDisabled === true ? CUSTOM_PROVIDER_WIRE_ID_SCHEMA : undefined);
        const requiredSchemas = [...new Set([protectedSchema, runtimeSchema].filter((schema) => schema !== undefined))];
        if ((await Promise.all(requiredSchemas.map(runtimeSchemaWritable))).some((writable) => !writable)) {
          throw new CustomProviderRuntimeNotReadyError(
            "custom model aliases are unavailable until the compatibility rollout is complete",
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
