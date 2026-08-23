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

export interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  modelHistory?: string[];
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  hasKey: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface CustomProviderStore {
  /** Enabled specs only — what the runtime registry should serve. */
  enabled(): Promise<CustomProviderSpec[]>;
  /** Everything, for the admin surface (no secrets). */
  statuses(): Promise<CustomProviderStatus[]>;
  /** Plaintext key for one provider, or null when absent/disabled. */
  resolveKey(id: string): Promise<string | null>;
  resolveActive(id: string): Promise<{ provider: CustomProviderSpec; apiKey: string | null } | null>;
  active(): Promise<Array<{ provider: CustomProviderSpec; apiKey: string | null }>>;
  knowsModel(id: string): Promise<boolean>;
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
}): CustomProviderStore {
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");
  const withRegistryLock = <T>(operation: () => Promise<T>): Promise<T> =>
    input.advisoryLock ? input.advisoryLock.withLock("custom-model-providers", operation) : operation();

  return {
    async enabled() {
      const all = await input.backing.all();
      return all.filter((p) => !p.disabled).map(strip);
    },

    async statuses() {
      const all = await input.backing.all();
      return all
        .map((p) => ({
          ...strip(p),
          disabled: p.disabled ?? false,
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id) {
      const saved = await input.backing.get(id);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async resolveActive(id) {
      const saved = await input.backing.get(id);
      if (!saved || saved.disabled) return null;
      return {
        provider: strip(saved),
        apiKey: saved.apiKeyEnc ? decryptSecret(saved.apiKeyEnc, key) : null,
      };
    },

    async active() {
      const all = await input.backing.all();
      return all
        .filter((saved) => !saved.disabled)
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

    async upsert(spec, apiKey, updatedBy) {
      await withRegistryLock(async () => {
        validateCustomProviderSpec(spec);
        const conflict = (await input.backing.all()).find(
          (saved) =>
            !saved.disabled &&
            saved.id !== spec.id &&
            saved.models.some((model) => spec.models.some((candidate) => candidate.id === model.id)),
        );
        if (conflict) throw new Error(`custom model id is already registered by provider "${conflict.id}"`);
        const actor = updatedBy.trim();
        if (!actor) throw new Error("updatedBy is required");
        const existing = await input.backing.get(spec.id);
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
          disabled: false,
          updatedAt: Date.now(),
          updatedBy: actor,
        });
      });
    },

    async delete(id, updatedBy) {
      return withRegistryLock(async () => {
        const existing = await input.backing.get(id);
        if (!existing || existing.disabled) return false;
        await input.backing.put(id, {
          ...existing,
          disabled: true,
          updatedAt: Date.now(),
          updatedBy,
        });
        return true;
      });
    },
  };
}
