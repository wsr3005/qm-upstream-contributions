import type { Runtime } from "./wiring.ts";

export async function startRuntime(runtime: Runtime, afterReady?: () => void): Promise<void> {
  await runtime.ready();
  runtime.start();
  afterReady?.();
}
