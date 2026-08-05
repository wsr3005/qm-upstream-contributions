import { isDeepStrictEqual } from "node:util";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { stableAmbientWakeEnvelope } from "../core/wake-envelope.ts";
import type { Run } from "./run-store.ts";

export function deduplicatedRunMatches(run: Run, sessionId: string, request: OrchestratorInput): boolean {
  return run.sessionId === sessionId && isDeepStrictEqual(runIdentity(run.request), runIdentity(request));
}

function runIdentity(request: OrchestratorInput): OrchestratorInput {
  const identity = structuredClone(request);
  if (identity.origin.kind === "automation" && identity.actor.id.startsWith("system:ambient:")) {
    identity.text = stableAmbientWakeEnvelope(identity.text);
  }
  delete identity.intakePreambleMs;
  delete identity.clientSentAt;
  return identity;
}
