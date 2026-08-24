import type { InstanceRegistry } from "./instance-registry.ts";
import type { TaskProtection } from "./task-protection.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface DrainController {
  ready(): Promise<void>;
  start(): void;
  stop(): void;
  canClaim(): boolean;
  readyForTraffic(): boolean;
  noteBusy(): void;
}

const DRAIN_SWEEP_MS = 10_000;
const REGISTRY_FRESHNESS_MS = 25_000;

export function createDrainController(opts: {
  registry: InstanceRegistry;
  protection: TaskProtection | null;
  busy: () => boolean;
  sweepMs?: number;
  freshnessMs?: number;
}): DrainController {
  let superseded = false;
  let protectionOn = false;
  let registryHealthy = false;
  let lastRegistryBeatAt = 0;
  let readyP: Promise<void> | null = null;
  const registryBeat = async () => {
    try {
      const wasSuperseded = superseded;
      superseded = await opts.registry.beat();
      registryHealthy = true;
      lastRegistryBeatAt = Date.now();
      if (superseded !== wasSuperseded) {
        console.error(
          `[drain] ${superseded ? "newer build is live — draining: no new run claims, finishing in-flight turns" : "newer build gone — resuming run claims"}`,
        );
      }
    } catch (error) {
      registryHealthy = false;
      throw error;
    }
  };
  const beat = async () => {
    await registryBeat();
    if (!opts.protection) return;
    const busy = opts.busy();
    if (busy) {
      await opts.protection.set(true);
      protectionOn = true;
    } else if (protectionOn) {
      await opts.protection.set(false);
      protectionOn = false;
    }
  };
  const sweeper: Sweeper = createSweeper(beat, opts.sweepMs ?? DRAIN_SWEEP_MS, {
    label: "deploy-drain",
    immediate: true,
  });
  return {
    ready: () => {
      if (!readyP) {
        readyP = registryBeat().catch((error) => {
          readyP = null;
          throw error;
        });
      }
      return readyP;
    },
    start: () => sweeper.start(),
    stop: () => {
      sweeper.stop();
      registryHealthy = false;
      if (protectionOn && opts.protection) {
        protectionOn = false;
        void opts.protection.set(false);
      }
    },
    canClaim: () => !superseded,
    readyForTraffic: () =>
      registryHealthy && Date.now() - lastRegistryBeatAt < (opts.freshnessMs ?? REGISTRY_FRESHNESS_MS),
    noteBusy: () => {
      if (!opts.protection || protectionOn) return;
      protectionOn = true;
      void opts.protection.set(true);
    },
  };
}
