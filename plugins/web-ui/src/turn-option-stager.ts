import type { Agent } from "@earendil-works/pi-agent-core";
import type { TurnOptions } from "./core-bridge";

export function createTurnOptionStager(): {
  stage(agent: Agent, options: TurnOptions): void;
  take(agent: Agent, fallback: () => TurnOptions): TurnOptions;
} {
  const staged = new WeakMap<Agent, TurnOptions>();
  return {
    stage(agent, options) {
      staged.set(agent, options);
    },
    take(agent, fallback) {
      const options = staged.get(agent);
      if (!options) return fallback();
      staged.delete(agent);
      return options;
    },
  };
}
