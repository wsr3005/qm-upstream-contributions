import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { CONFIG_DEFAULTS, type Config } from "../config.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { DEFAULT_CODEX_MODEL_ID, modelSupportedByHarness } from "../model/pi-models.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import type { TaskStatus, TaskStore } from "../tasks/task-store.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { countTokens } from "../util/tokens.ts";
import { parseSecurityScreenVerdict, SECURITY_SCREEN_SYSTEM_PROMPT } from "../security/security-posture.ts";
import { CodexAppServer, CodexRpcError } from "./codex-app-server.ts";
import {
  defineHarness,
  HarnessModelTestError,
  modelTestError,
  type Harness,
  type HarnessModelTestInput,
  type HarnessTurnInput,
  type HarnessTurnResult,
} from "./harness.ts";
import { coreToolOptions, createPiTools, type PiToolsOptions, type ToolContextRef } from "./pi-tools.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { reconstructMessagesFromHistory, seedPriorTurns, type PiReplayMessage } from "./replay.ts";
import { createModelTestProxy } from "./model-test-proxy.ts";
import { createCodexProviderProxy } from "./codex-provider-proxy.ts";

export interface CodexHarnessOptions {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  judgeModelId?: string;
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
  controlTools?: boolean;
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  appServerStartTimeoutMs?: number;
  signals?: RunSignalStore;
  tasks?: TaskStore;
  resolveCustomProvider?: (modelId: string) => Promise<CodexCustomProviderBinding | null>;
}

export interface CodexCustomProviderBinding {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId?: string;
}

export function codexHarnessConfigOptions(config: Config): CodexHarnessOptions {
  return {
    ...(config.codexModel ? { defaultModelId: config.codexModel } : {}),
    ...(config.judgeModelId && modelSupportedByHarness(config.judgeModelId, "codex")
      ? { judgeModelId: config.judgeModelId }
      : {}),
    ...(config.codexBinPath ? { binaryPath: config.codexBinPath } : {}),
    env: config.codexProcessEnv,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

export function codexToolContext(turn: HarnessTurnInput): ToolContextRef {
  return {
    current: turn.tools,
    pendingApprovals: [],
    pausedOnApproval: false,
    silentRequested: false,
    pollFire: Boolean(turn.pollFire),
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenExternalContent: turn.screenExternalContent,
    toolApprovalGate: turn.toolApprovalGate,
  };
}

type BridgedTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    callId: string,
    args: unknown,
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; terminate?: boolean }>;
};

type CodexItem = Record<string, unknown> & { type: string };
type CodexTurn = { id: string; status: string; error?: { message?: string } | null; items?: CodexItem[] };
type ActiveTurn = {
  threadId: string;
  turn: HarnessTurnInput;
  tools: Map<string, BridgedTool>;
  resolve(turn: CodexTurn): void;
  reject(error: Error): void;
  responseItems: CodexItem[];
  completedItems: CodexItem[];
  taskIds: Map<string, string>;
  taskStatuses: Map<string, TaskStatus>;
  taskResults: Set<string>;
  model: string;
  modelCalls: number;
  usageInputTotals: Map<string, number>;
  usageByThread: Map<string, LlmCallUsage>;
  firstOutputAt: number | null;
  fallbackInputTokens: number;
  tapeWriteFailed: boolean;
  interrupt?: () => Promise<void>;
  stopped: boolean;
  runtime: Runtime;
};

type Runtime = {
  server: CodexAppServer;
  providerProxy?: Awaited<ReturnType<typeof createCodexProviderProxy>>;
  jail: string;
  key: string;
  family: string;
  retired: boolean;
  closing: boolean;
};
const CODEX_START_TIMEOUT_MS = 30_000;

const CODEX_NON_RETRYABLE_PATTERN =
  /\b(?:401|402|403)\b|unauthoriz|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication (?:error|failed)|missing bearer|missing (?:api key|credentials)|not logged in|codex login|insufficient[_ -]?quota|exceeded your current quota|billing|credit(?: balance| limit)|out of credits|credits_depleted|must be verified|model[_ -]?not[_ -]?found|does not exist or you do not have access|unsupported[_ -]?model/i;

export function codexNonRetryable(message: string): boolean {
  return CODEX_NON_RETRYABLE_PATTERN.test(message);
}

export function codexProviderFailure(message: string): Error {
  return codexNonRetryable(message) ? new NonRetryableTurnError(message) : new Error(message);
}
const CODEX_CHILD_TOOL_NAMES = new Set(["execute", "read", "write", "publish", "memory", "history", "background"]);

export function codexChildToolAllowed(name: string): boolean {
  return CODEX_CHILD_TOOL_NAMES.has(name);
}

function usageNumber(value: unknown, ...names: string[]): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    if (!(name in record)) continue;
    const parsed = Number(record[name]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export function codexUsageTotals(params: unknown): LlmCallUsage | null {
  if (!params || typeof params !== "object") return null;
  const tokenUsage = (params as Record<string, unknown>).tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const total = (tokenUsage as Record<string, unknown>).total;
  if (!total || typeof total !== "object") return null;
  const input = usageNumber(total, "inputTokens", "input_tokens");
  const output = usageNumber(total, "outputTokens", "output_tokens");
  const cacheRead = usageNumber(total, "cachedInputTokens", "cached_input_tokens");
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output, costUsd: 0 };
}

function sumUsage(byThread: ReadonlyMap<string, LlmCallUsage>): LlmCallUsage | null {
  if (!byThread.size) return null;
  const total: LlmCallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  for (const usage of byThread.values()) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.totalTokens += usage.totalTokens;
  }
  return total;
}

export function codexTokenUsageUpdate(
  params: unknown,
  priorInputTokens = 0,
): { inputTokens: number; totalInputTokens: number } | null {
  if (!params || typeof params !== "object") return null;
  const tokenUsage = (params as Record<string, unknown>).tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const usage = tokenUsage as Record<string, unknown>;
  const totalInputTokens = usageNumber(usage.total, "inputTokens", "input_tokens");
  if (totalInputTokens <= priorInputTokens) return null;
  const lastInputTokens = usageNumber(usage.last, "inputTokens", "input_tokens");
  return { inputTokens: lastInputTokens || totalInputTokens - priorInputTokens, totalInputTokens };
}

const CODEX_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "no_proxy",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_ACCESS_TOKEN",
  "QM_CODEX_PROVIDER_KEY",
] as const;

export function codexChildEnv(source: NodeJS.ProcessEnv, jail: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: jail,
    CODEX_HOME: join(jail, "codex-home"),
  };
  for (const name of CODEX_ENV_PASSTHROUGH) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export function prepareCodexHome(source: NodeJS.ProcessEnv, jail: string): string {
  const target = join(jail, "codex-home");
  mkdirSync(target, { recursive: true });
  if (source.OPENAI_API_KEY) {
    writeFileSync(
      join(target, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: source.OPENAI_API_KEY }),
      { mode: 0o600 },
    );
  }
  return target;
}

export function codexCustomRuntimeSpec(
  source: NodeJS.ProcessEnv,
  binding: CodexCustomProviderBinding | null,
  disableRetries = false,
): { key: string; family: string; env: NodeJS.ProcessEnv; config: Record<string, unknown> } {
  if (!binding) return { key: "default", family: "default", env: source, config: {} };
  const noProxy = [
    ...new Set([
      ...(source.NO_PROXY ?? "").split(","),
      ...(source.no_proxy ?? "").split(","),
      "127.0.0.1",
      "localhost",
      "::1",
    ]),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(",");
  const env: NodeJS.ProcessEnv = {
    ...source,
    QM_CODEX_PROVIDER_KEY: binding.apiKey,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.CODEX_ACCESS_TOKEN;
  const key = createHash("sha256")
    .update(JSON.stringify([binding.id, binding.baseUrl, binding.apiKey]))
    .digest("hex");
  return {
    key: `custom:${binding.id}:${key}`,
    family: `custom:${binding.id}`,
    env,
    config: {
      model_provider: binding.id,
      model_providers: {
        [binding.id]: {
          name: binding.name,
          base_url: binding.baseUrl,
          env_key: "QM_CODEX_PROVIDER_KEY",
          wire_api: "responses",
          ...(disableRetries ? { request_max_retries: 0, stream_max_retries: 0 } : {}),
        },
      },
    },
  };
}

async function transitionTask(
  store: TaskStore | undefined,
  id: string,
  expected: TaskStatus,
  next: TaskStatus,
  runId: string,
): Promise<void> {
  if (!store) return;
  const updated = await store.transitionStatus(id, expected, next, runId);
  if (!updated) throw new Error(`task ${id} was not ${expected} while transitioning to ${next}`);
}

function toolOptions(opts: CodexHarnessOptions, turn?: HarnessTurnInput): PiToolsOptions {
  return {
    scratchExec: opts.scratchExec,
    ownerAuthExec: opts.ownerAuthExec,
    reachExec: opts.reachExec,
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
    controlTools: opts.controlTools,
    execTimeoutMs: opts.execTimeoutMs,
    execTimeoutCeilingMs: opts.execTimeoutCeilingMs,
    backgroundJobTtlMs: opts.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: opts.backgroundJobTtlMaxMs,
    ...(turn
      ? {
          readOnly: turn.readOnly,
          surfaceTools: turn.surfaceTools,
          surfaceName: turn.surfaceName,
          credentialExecServices: turn.credentialExecServices,
        }
      : { surfaceTools: true, surfaceName: "slack" }),
  };
}

function asTools(ref: ToolContextRef, options: PiToolsOptions): BridgedTool[] {
  return createPiTools(ref, options) as unknown as BridgedTool[];
}

function userInput(text: string): Record<string, unknown> {
  return { type: "text", text, text_elements: [] };
}

export function codexReplayCallId(id: string): string {
  return id.length <= 64 ? id : createHash("sha256").update(id).digest("hex");
}

function replayItems(messages: readonly PiReplayMessage[]): CodexItem[] {
  const out: CodexItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        type: "message",
        role: "user",
        content: message.content.map((part) => ({ type: "input_text", text: part.text })),
      });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        type: "function_call_output",
        call_id: codexReplayCallId(message.toolCallId),
        output: message.content.map((part) => part.text).join("\n"),
      });
      continue;
    }
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    for (const part of message.content) {
      if (part.type === "toolCall")
        out.push({
          type: "function_call",
          call_id: codexReplayCallId(part.id),
          name: part.name,
          arguments: JSON.stringify(part.arguments),
        });
    }
  }
  return out;
}

function textFromTurn(turn: CodexTurn): string {
  const messages = (turn.items ?? []).filter((item) => item.type === "agentMessage" && typeof item.text === "string");
  const final = messages.filter((item) => item.phase === "final_answer");
  const unphased = messages.filter((item) => item.phase === undefined || item.phase === null);
  let selected = messages;
  if (final.length) selected = final;
  else if (unphased.length) selected = unphased;
  return selected
    .map((item) => String(item.text))
    .join("\n")
    .trim();
}

function reasoningFromTurn(turn: CodexTurn): string[] {
  return (turn.items ?? []).flatMap((item) =>
    item.type === "reasoning" && Array.isArray(item.summary)
      ? item.summary.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [],
  );
}

function toolText(result: Awaited<ReturnType<BridgedTool["execute"]>>): string {
  return (result.content ?? [])
    .filter((item): item is { type?: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function codexTaskTitle(prompt: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim()) return "subagent task";
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const named = /\bYou are (?:the )?([^.!?]{1,80}? subagent)\b/i.exec(normalized)?.[1];
  const title = named ?? normalized;
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

export function codexReasoningEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

export function codexTurnInputText(
  turn: Pick<HarnessTurnInput, "history" | "priorTurns" | "input" | "environment">,
): string {
  const prior = turn.history.length
    ? ""
    : seedPriorTurns(turn.priorTurns ?? [])
        .map((message) => message.text)
        .join("\n");
  return [prior, turn.input, turn.environment].filter((item) => item?.trim()).join("\n\n");
}

export function createCodexHarness(opts: CodexHarnessOptions = {}): Harness {
  const active = new Map<string, ActiveTurn>();
  const configuredModel = opts.modelId;
  const judgeModelId = opts.judgeModelId ?? "gpt-5.4-mini";
  const resolveModelId = (scope?: ScopeId) =>
    [
      typeof configuredModel === "function" ? configuredModel(scope) : configuredModel,
      opts.defaultModelId,
      DEFAULT_CODEX_MODEL_ID,
    ].find((id): id is string => modelSupportedByHarness(id, "codex"))!;
  const defaultTurnWallClockMs = opts.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const runtimes = new Map<string, Runtime>();
  const starting = new Map<string, Promise<Runtime>>();
  const startingServers = new Set<CodexAppServer>();
  const reservations = new Map<string, number>();
  const desiredRuntimeByFamily = new Map<string, string>();

  const closeRuntime = async (runtime: Runtime): Promise<void> => {
    if (runtime.closing) return;
    runtime.closing = true;
    if (runtimes.get(runtime.key) === runtime) runtimes.delete(runtime.key);
    try {
      await runtime.server.close();
    } finally {
      await runtime.providerProxy?.close();
      rmSync(runtime.jail, { recursive: true, force: true });
    }
  };
  const runtimeInUse = (runtime: Runtime) =>
    Boolean(reservations.get(runtime.key)) || [...active.values()].some((state) => state.runtime === runtime);
  const releaseReservation = async (key: string) => {
    const remaining = (reservations.get(key) ?? 1) - 1;
    if (remaining > 0) reservations.set(key, remaining);
    else reservations.delete(key);
    const runtime = runtimes.get(key);
    if (runtime?.retired && !runtimeInUse(runtime)) await closeRuntime(runtime).catch(() => undefined);
  };

  const processCollabItem = async (state: ActiveTurn, item: CodexItem): Promise<void> => {
    if (item.type !== "collabAgentToolCall") return;
    const tool = String(item.tool ?? "");
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    if (tool === "spawnAgent") {
      for (const receiver of receivers) {
        if (state.taskIds.has(receiver)) continue;
        const taskId = `${String(item.id)}:${receiver}`;
        if (opts.tasks)
          await opts.tasks.create({
            id: taskId,
            sessionId: state.turn.session.id,
            originRunId: state.turn.runId ?? state.turn.session.id,
            title: codexTaskTitle(item.prompt),
            status: "in_progress",
          });
        state.taskIds.set(receiver, taskId);
        state.taskStatuses.set(taskId, "in_progress");
        active.set(receiver, state);
        await state.turn.emit({
          type: "tool_call",
          payload: { tool: "spawnAgent", callId: taskId, prompt: item.prompt, receiverThreadId: receiver },
          scopeLabel: state.turn.scopeLabel,
        });
      }
    }
    const agents =
      item.agentsStates && typeof item.agentsStates === "object"
        ? (item.agentsStates as Record<string, { status?: unknown; message?: unknown }>)
        : {};
    for (const [receiver, agent] of Object.entries(agents)) {
      const taskId = state.taskIds.get(receiver);
      if (!taskId) continue;
      let next: TaskStatus | undefined;
      if (agent.status === "completed" || agent.status === "shutdown") next = "completed";
      else if (agent.status === "errored" || agent.status === "interrupted" || agent.status === "notFound") {
        next = "failed";
      } else if (agent.status === "running") next = "in_progress";
      const prior = state.taskStatuses.get(taskId);
      if (next && prior && next !== prior) {
        await transitionTask(opts.tasks, taskId, prior, next, state.turn.runId ?? state.turn.session.id);
        state.taskStatuses.set(taskId, next);
      }
      if ((next === "completed" || next === "failed") && !state.taskResults.has(taskId)) {
        state.taskResults.add(taskId);
        await state.turn.emit({
          type: "tool_result",
          payload: {
            tool: "spawnAgent",
            callId: taskId,
            result: typeof agent.message === "string" ? agent.message : next,
            isError: next === "failed",
          },
          scopeLabel: state.turn.scopeLabel,
        });
      }
    }
  };

  const ensureRuntime = async (spec: {
    key: string;
    family: string;
    env: NodeJS.ProcessEnv;
    providerBaseUrl?: string;
  }): Promise<Runtime> => {
    desiredRuntimeByFamily.set(spec.family, spec.key);
    const current = runtimes.get(spec.key);
    if (current && !current.closing && current.server.process.exitCode === null) return current;
    const pending = starting.get(spec.key);
    if (pending) {
      const joined = await pending;
      if (!joined.closing && joined.server.process.exitCode === null) return joined;
      if (starting.get(spec.key) === pending) starting.delete(spec.key);
      return ensureRuntime(spec);
    }
    const operation = (async () => {
      const jail = mkdtempSync(join(tmpdir(), "qm-codex-"));
      const sourceEnv = spec.env;
      prepareCodexHome(sourceEnv, jail);
      const binaryPath = opts.binaryPath ?? resolve("node_modules/.bin/codex");
      const providerProxy = spec.providerBaseUrl ? await createCodexProviderProxy(spec.providerBaseUrl) : undefined;
      const server = new CodexAppServer({
        binaryPath,
        cwd: jail,
        env: codexChildEnv(sourceEnv, jail),
        onNotification: async (method, params) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const threadId = typeof p.threadId === "string" ? p.threadId : "";
          const state = active.get(threadId);
          if (!state) return;
          if (method === "thread/tokenUsage/updated") {
            const totals = codexUsageTotals(p);
            if (totals) state.usageByThread.set(threadId, totals);
            const usage = codexTokenUsageUpdate(p, state.usageInputTotals.get(threadId));
            if (!usage) return;
            state.usageInputTotals.set(threadId, usage.totalInputTokens);
            state.modelCalls++;
            state.turn.recordModelCall({
              model: state.model,
              inputTokens: usage.inputTokens,
              entryCount: state.turn.history.length,
            });
          }
          if (method === "item/agentMessage/delta" && threadId === state.threadId && typeof p.delta === "string") {
            state.firstOutputAt ??= Date.now();
            state.turn.onDelta?.(p.delta);
          }
          if ((method === "item/started" || method === "item/completed") && p.item && typeof p.item === "object") {
            const item = p.item as CodexItem;
            if (method === "item/completed") {
              state.completedItems.push(item);
              if (state.turn.tape) {
                try {
                  await state.turn.tape({
                    kind: "message",
                    harness: "codex",
                    scopeLabel: state.turn.scopeLabel,
                    payload: item,
                  });
                } catch (error) {
                  state.tapeWriteFailed = true;
                  swallow("codex: tape append", error);
                }
              }
            }
            await processCollabItem(state, item);
          }
          if (method === "turn/completed" && threadId === state.threadId) {
            const completed = p.turn as CodexTurn | undefined;
            if (completed)
              state.resolve(completed.items?.length ? completed : { ...completed, items: state.completedItems });
          }
        },
        onRequest: async (method, params) => {
          if (method !== "item/tool/call") throw new Error(`unsupported Codex request ${method}`);
          const p = (params ?? {}) as Record<string, unknown>;
          const threadId = String(p.threadId ?? "");
          const state = active.get(threadId);
          if (!state) throw new Error("inactive Codex thread");
          const name = String(p.tool ?? "");
          const callId = String(p.callId ?? "");
          if (threadId !== state.threadId && !codexChildToolAllowed(name))
            throw new Error(`Codex child requested unavailable tool ${name}`);
          const tool = state.tools.get(name);
          if (!tool) throw new Error(`Codex requested unavailable tool ${name}`);
          state.responseItems.push({
            type: "function_call",
            call_id: callId,
            name,
            arguments: JSON.stringify(p.arguments ?? {}),
          });
          try {
            const result = await tool.execute(callId, p.arguments ?? {});
            const output = toolText(result);
            state.responseItems.push({ type: "function_call_output", call_id: callId, output });
            if (result.terminate || state.turn.cancel?.aborted)
              setImmediate(() => {
                const requestingTurnId = String(p.turnId ?? "");
                if (threadId !== state.threadId && requestingTurnId) {
                  void server.request("turn/interrupt", { threadId, turnId: requestingTurnId }).catch(() => undefined);
                }
                void state.interrupt?.();
              });
            return { contentItems: [{ type: "inputText", text: output }], success: true };
          } catch (error) {
            const output = error instanceof Error ? error.message : String(error);
            state.responseItems.push({ type: "function_call_output", call_id: callId, output });
            return { contentItems: [{ type: "inputText", text: output }], success: false };
          }
        },
      });
      startingServers.add(server);
      let startTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          server.initialize(),
          new Promise<never>((_, reject) => {
            startTimer = setTimeout(
              () => reject(new Error("Codex app-server initialization timed out")),
              opts.appServerStartTimeoutMs ?? CODEX_START_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        await server.close().catch(() => undefined);
        await providerProxy?.close().catch(() => undefined);
        rmSync(jail, { recursive: true, force: true });
        throw error;
      } finally {
        if (startTimer) clearTimeout(startTimer);
        startingServers.delete(server);
      }
      const runtime = {
        server,
        ...(providerProxy ? { providerProxy } : {}),
        jail,
        key: spec.key,
        family: spec.family,
        retired: spec.family.startsWith("custom:") || desiredRuntimeByFamily.get(spec.family) !== spec.key,
        closing: false,
      };
      runtimes.set(spec.key, runtime);
      server.process.once("close", () => {
        if (runtimes.get(spec.key)?.server !== server) return;
        for (const state of active.values())
          if (state.runtime.server === server)
            state.reject(server.error() ?? new Error("Codex app-server exited during a turn"));
        for (const [threadId, state] of active) if (state.runtime.server === server) active.delete(threadId);
        runtimes.delete(spec.key);
        void providerProxy?.close();
        rmSync(jail, { recursive: true, force: true });
      });
      const idlePriorVersions: Runtime[] = [];
      if (!runtime.retired) {
        for (const [key, prior] of runtimes) {
          if (key === spec.key || prior.family !== spec.family) continue;
          prior.retired = true;
          if (!runtimeInUse(prior)) idlePriorVersions.push(prior);
        }
      }
      if (runtime.retired && !runtimeInUse(runtime)) idlePriorVersions.push(runtime);
      await Promise.all(idlePriorVersions.map((prior) => closeRuntime(prior).catch(() => undefined)));
      return runtime;
    })();
    starting.set(spec.key, operation);
    try {
      return await operation;
    } finally {
      if (starting.get(spec.key) === operation) starting.delete(spec.key);
    }
  };

  const runPrompt = async (
    turn: HarnessTurnInput,
    toolsEnabled = true,
    disableProviderRetries = false,
    customProvider?: HarnessModelTestInput["customProvider"],
  ): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    if (turn.model && !customProvider && !modelSupportedByHarness(turn.model, "codex")) {
      throw new NonRetryableTurnError(`Codex does not support requested model ${turn.model}`);
    }
    const wallMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;
    const deadline = wallMs > 0 ? Date.now() + wallMs : 0;
    const setupCancelled = new Error("Codex setup cancelled");
    const setupTimedOut = new NonRetryableTurnError(`Codex turn exceeded ${Math.round(wallMs / 1000)}s wall clock`);
    let rejectSetup!: (error: Error) => void;
    let setupSettled = false;
    const setupStop = new Promise<never>((_, reject) => {
      rejectSetup = reject;
    });
    const stopSetup = (error: Error) => {
      if (setupSettled) return;
      setupSettled = true;
      rejectSetup(error);
    };
    const onSetupCancel = () => stopSetup(setupCancelled);
    turn.cancel?.addEventListener("abort", onSetupCancel, { once: true });
    const setupTimer = wallMs > 0 ? setTimeout(() => stopSetup(setupTimedOut), wallMs) : undefined;
    const awaitSetup = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, setupStop]);
    const model = turn.model ?? resolveModelId(turn.scopeLabel);
    let runtimeModel: string;
    let rt: Runtime;
    let runtimeConfig: Record<string, unknown>;
    let reservedRuntimeKey: string | null = null;
    try {
      const customModel = customProvider?.spec.models.find((candidate) => candidate.id === model);
      if (customProvider?.spec.protocol !== undefined && customProvider.spec.protocol !== "openai-responses")
        throw new NonRetryableTurnError(`Codex requires an OpenAI Responses custom provider`);
      if (customProvider && !customModel)
        throw new NonRetryableTurnError(`Codex custom provider snapshot does not contain model ${model}`);
      let binding: CodexCustomProviderBinding | null = null;
      if (customProvider) {
        binding = {
          id: customProvider.spec.id,
          name: customProvider.spec.name,
          baseUrl: customProvider.spec.baseUrl,
          apiKey: customProvider.apiKey,
          modelId: customModel!.upstreamId?.trim() || customModel!.id,
        };
      } else if (opts.resolveCustomProvider) {
        binding = await awaitSetup(opts.resolveCustomProvider(model));
      }
      runtimeModel = binding?.modelId ?? model;
      const spec = codexCustomRuntimeSpec(opts.env ?? {}, binding, disableProviderRetries);
      reservedRuntimeKey = spec.key;
      reservations.set(spec.key, (reservations.get(spec.key) ?? 0) + 1);
      rt = await awaitSetup(ensureRuntime({ ...spec, ...(binding ? { providerBaseUrl: binding.baseUrl } : {}) }));
      runtimeConfig = binding
        ? {
            ...spec.config,
            model_providers: {
              [binding.id]: {
                ...(spec.config.model_providers as Record<string, Record<string, unknown>>)[binding.id],
                base_url: rt.providerProxy?.baseUrl ?? binding.baseUrl,
              },
            },
          }
        : spec.config;
      if (spec.family.startsWith("custom:")) rt.retired = true;
    } catch (error) {
      if (reservedRuntimeKey) await releaseReservation(reservedRuntimeKey);
      setupSettled = true;
      if (setupTimer) clearTimeout(setupTimer);
      turn.cancel?.removeEventListener("abort", onSetupCancel);
      if (error === setupCancelled) return { reply: "", stopped: true };
      throw error;
    }
    const ref = codexToolContext(turn);
    const toolAbort = new AbortController();
    ref.abortSignal = toolAbort.signal;
    let tools: ReturnType<typeof asTools>;
    try {
      tools = toolsEnabled ? asTools(ref, toolOptions(opts, turn)) : [];
    } catch (error) {
      if (reservedRuntimeKey) await releaseReservation(reservedRuntimeKey);
      setupSettled = true;
      if (setupTimer) clearTimeout(setupTimer);
      turn.cancel?.removeEventListener("abort", onSetupCancel);
      throw error;
    }
    const dynamicTools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
    const threadStartRequest = {
      ...(runtimeModel ? { model: runtimeModel } : {}),
      cwd: rt.jail,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: turn.systemPrompt,
      developerInstructions:
        "Use the supplied dynamic tools for all workspace, execution, memory, history, and surface operations. The built-in working directory is an empty read-only control jail, not the user's workspace.",
      dynamicTools,
      experimentalRawEvents: true,
      environments: [],
      config: {
        ...runtimeConfig,
        web_search: "disabled",
        ...(codexReasoningEffort(turn.thinkingLevel)
          ? { model_reasoning_effort: codexReasoningEffort(turn.thinkingLevel) }
          : {}),
        features: {
          shell_tool: false,
          unified_exec: false,
          shell_snapshot: false,
          apps: false,
          plugins: false,
          browser_use: false,
          browser_use_external: false,
          computer_use: false,
          image_generation: false,
          in_app_browser: false,
          multi_agent: !turn.readOnly,
          request_permissions_tool: false,
          tool_suggest: false,
        },
      },
    };
    let started: { thread: { id: string }; model?: string };
    try {
      started = await awaitSetup(rt.server.request("thread/start", threadStartRequest));
    } catch (error) {
      if (reservedRuntimeKey) await releaseReservation(reservedRuntimeKey);
      setupSettled = true;
      if (setupTimer) clearTimeout(setupTimer);
      turn.cancel?.removeEventListener("abort", onSetupCancel);
      if (error === setupCancelled) return { reply: "", stopped: true };
      throw error;
    }
    const threadId = started.thread.id;
    const replay = replayItems(reconstructMessagesFromHistory(turn.history));
    let userEntry: SessionEntry;
    try {
      if (replay.length) await awaitSetup(rt.server.request("thread/inject_items", { threadId, items: replay }));
      userEntry = await awaitSetup(
        turn.emit({
          type: "user",
          payload: {
            text: turn.input,
            ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          },
          scopeLabel: turn.scopeLabel,
        }),
      );
    } catch (error) {
      if (reservedRuntimeKey) await releaseReservation(reservedRuntimeKey);
      setupSettled = true;
      if (setupTimer) clearTimeout(setupTimer);
      turn.cancel?.removeEventListener("abort", onSetupCancel);
      if (error === setupCancelled) return { reply: "", stopped: true };
      throw error;
    }
    setupSettled = true;
    if (setupTimer) clearTimeout(setupTimer);
    turn.cancel?.removeEventListener("abort", onSetupCancel);
    let resolveCompleted!: (value: CodexTurn) => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<CodexTurn>((resolveTurn, rejectTurn) => {
      resolveCompleted = resolveTurn;
      rejectCompleted = rejectTurn;
    });
    const inputText = codexTurnInputText(turn);
    const input = [
      userInput(inputText),
      ...(turn.images ?? []).map((image) => ({
        type: "image",
        url: `data:${image.mimeType};base64,${image.dataBase64}`,
      })),
    ];
    const selectedModel = model ?? started.model ?? "codex-default";
    const state: ActiveTurn = {
      threadId,
      turn,
      tools: new Map(tools.map((tool) => [tool.name, tool])),
      resolve: resolveCompleted,
      reject: rejectCompleted,
      responseItems: [],
      completedItems: [],
      taskIds: new Map(),
      taskStatuses: new Map(),
      taskResults: new Set(),
      model: selectedModel,
      modelCalls: 0,
      usageInputTotals: new Map(),
      usageByThread: new Map(),
      firstOutputAt: null,
      fallbackInputTokens: countTokens(JSON.stringify({ replay, input })),
      tapeWriteFailed: false,
      stopped: false,
      runtime: rt,
    };
    active.set(threadId, state);
    if (reservedRuntimeKey) await releaseReservation(reservedRuntimeKey);
    const promptEnvelope = {
      threadStart: {
        ...threadStartRequest,
        cwd: "[ephemeral control jail]",
      },
    };
    const startedAt = Date.now();
    const recordRequest = async (): Promise<void> => {
      if (!turn.recordLlmRequest) return;
      try {
        await turn.recordLlmRequest({
          turnSeq: userEntry.seq,
          step: 0,
          model: selectedModel,
          promptEnvelope,
          truncated: Boolean(turn.images?.length),
          transport: { modelId: runtimeModel },
          ttftMs: state.firstOutputAt ? state.firstOutputAt - startedAt : null,
          durationMs: Date.now() - startedAt,
          usage: sumUsage(state.usageByThread),
        });
      } catch (error) {
        swallow("codex: llm request record", error);
      }
    };
    if (turn.tape) {
      try {
        await turn.tape({
          kind: "message",
          harness: "codex",
          scopeLabel: turn.scopeLabel,
          entrySeq: userEntry.seq,
          meta: {
            bareText: turn.input,
            ...((turn.triggerTs ?? turn.entryTs) ? { ts: (turn.triggerTs ?? turn.entryTs)! } : {}),
          },
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: inputText },
              ...(turn.images ?? []).map((image) => ({
                type: "input_image",
                image_url: "[image bytes omitted]",
                media_type: image.mimeType,
              })),
            ],
          },
        });
      } catch (error) {
        state.tapeWriteFailed = true;
        swallow("codex: tape append", error);
      }
    }
    let turnId = "";
    const interrupt = async (stopped: boolean) => {
      state.stopped ||= stopped;
      toolAbort.abort();
      if (turnId) await rt.server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    };
    state.interrupt = () => interrupt(false);
    const onCancel = () => {
      void interrupt(false);
    };
    if (turn.cancel) {
      if (turn.cancel.aborted) onCancel();
      else turn.cancel.addEventListener("abort", onCancel, { once: true });
    }
    const stopSignals =
      opts.signals && turn.runId
        ? startSignalPoll(
            opts.signals,
            turn.runId,
            {
              onAbort: async () => interrupt(true),
              onSteer: async (text, ts) => {
                await turn.emit({
                  type: "user",
                  payload: { text, ...(ts ? { ts } : {}), steered: true },
                  scopeLabel: turn.scopeLabel,
                });
                await rt.server.request("turn/steer", { threadId, expectedTurnId: turnId, input: [userInput(text)] });
              },
            },
            { onError: (error) => swallow("codex signal poll", error) },
          )
        : null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const response = await rt.server
        .request<{ turn: CodexTurn }>("turn/start", {
          threadId,
          input,
          ...(runtimeModel ? { model: runtimeModel } : {}),
        })
        .catch((error: unknown) => {
          throw error instanceof CodexRpcError ? codexProviderFailure(error.message) : error;
        });
      turnId = response.turn.id;
      if (toolAbort.signal.aborted || turn.cancel?.aborted) await interrupt(false);
      const remainingWallMs = deadline ? Math.max(1, deadline - Date.now()) : 0;
      const result =
        remainingWallMs > 0
          ? await Promise.race([
              completed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  void interrupt(false);
                  reject(setupTimedOut);
                }, remainingWallMs);
              }),
            ])
          : await completed;
      if (state.modelCalls === 0) {
        state.modelCalls = 1;
        turn.recordModelCall({
          model: selectedModel,
          inputTokens: state.fallbackInputTokens,
          entryCount: turn.history.length,
        });
      }
      if (result.status === "failed") throw codexProviderFailure(result.error?.message ?? "Codex turn failed");
      const terminal = ref.silentRequested || ref.pausedOnApproval;
      const reply = terminal ? "" : textFromTurn(result);
      for (const thinking of reasoningFromTurn(result))
        await turn.emit({ type: "thinking", payload: { thinking }, scopeLabel: turn.scopeLabel });
      if (reply && !terminal)
        await turn.emit({
          type: "assistant",
          payload: { text: reply, stopped: state.stopped || undefined },
          scopeLabel: turn.scopeLabel,
        });
      return {
        reply,
        ...(state.stopped ? { stopped: true as const } : {}),
        ...(ref.silentRequested ? { silent: true } : {}),
        ...(ref.pendingApprovals?.length ? { pendingApprovals: ref.pendingApprovals } : {}),
        ...(ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
        modelCalls: state.modelCalls,
        ...(state.tapeWriteFailed ? { tapeWriteFailed: true } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      await stopSignals?.();
      await recordRequest();
      turn.cancel?.removeEventListener("abort", onCancel);
      for (const [taskId, status] of state.taskStatuses) {
        if (status === "pending" || status === "in_progress") {
          await transitionTask(opts.tasks, taskId, status, "failed", turn.runId ?? turn.session.id);
        }
      }
      for (const [activeThreadId, activeState] of active) {
        if (activeState === state) active.delete(activeThreadId);
      }
      if (rt.retired && !runtimeInUse(rt)) await closeRuntime(rt).catch(() => undefined);
    }
  };

  const single = async (
    systemPrompt: string,
    prompt: string,
    signal?: AbortSignal,
    observe?: Pick<HarnessTurnInput, "recordModelCall" | "recordLlmRequest">,
    modelOverride?: string,
    disableProviderRetries = false,
    customProvider?: HarnessModelTestInput["customProvider"],
  ): Promise<string | undefined> => {
    const session = { id: `oneshot-${randomBytes(8).toString("hex")}` } as HarnessTurnInput["session"];
    const scope = { kind: "org", id: "oneshot" } as unknown as ScopeId;
    const emitted: SessionEntry[] = [];
    const result = await runPrompt(
      {
        session,
        input: prompt,
        systemPrompt,
        history: [],
        tools: {} as HarnessTurnInput["tools"],
        scopeLabel: scope,
        orgScopeId: scope,
        ...(signal ? { cancel: signal } : {}),
        ...(modelOverride ? { model: modelOverride } : {}),
        readOnly: true,
        emit: async (entry) => {
          const saved = {
            ...entry,
            sessionId: session.id,
            seq: emitted.length + 1,
            createdAt: Date.now(),
          } as SessionEntry;
          emitted.push(saved);
          return saved;
        },
        recordModelCall: observe?.recordModelCall ?? (() => {}),
        ...(observe?.recordLlmRequest ? { recordLlmRequest: observe.recordLlmRequest } : {}),
      },
      false,
      disableProviderRetries,
      customProvider,
    );
    return result.reply || undefined;
  };

  return defineHarness(
    {
      id: "codex",
      controlTransport: "json-rpc",
      toolTransport: "dynamic",
      transcriptFormat: "responses-api",
      capabilities: new Set(["abort", "steer", "images", "provider-sessions"]),
    },
    {
      runTurn: runPrompt,
      close: async () => {
        await Promise.all([...startingServers].map((server) => server.close().catch(() => undefined)));
        await Promise.all([...starting.values()].map((operation) => operation.catch(() => undefined)));
        for (const state of active.values()) state.reject(new Error("Codex harness closed during a turn"));
        active.clear();
        const current = [...runtimes.values()];
        runtimes.clear();
        await Promise.all(current.map((runtime) => closeRuntime(runtime)));
        for (const runtime of current) rmSync(runtime.jail, { recursive: true, force: true });
      },
      resetSession: () => {},
      oneShot: (system, prompt) => single(system, prompt),
      testModel: async (input) => {
        if (!input.customProvider)
          throw new NonRetryableTurnError("Codex model test requires a custom provider snapshot");
        const controller = new AbortController();
        const proxy = await createModelTestProxy(input.customProvider.spec.baseUrl, {
          signal: controller.signal,
          expectedModel: input.expectedUpstreamModel,
          maxOutputTokens: input.maxOutputTokens,
        });
        let timer: NodeJS.Timeout | undefined;
        let runtimeReservation: string | undefined;
        try {
          const customProvider = {
            ...input.customProvider,
            spec: { ...input.customProvider.spec, baseUrl: proxy.baseUrl },
          };
          const selected = customProvider.spec.models.find((candidate) => candidate.id === input.model);
          if (!selected) throw new HarnessModelTestError("runtime_startup_failed", proxy.attempt());
          const binding: CodexCustomProviderBinding = {
            id: customProvider.spec.id,
            name: customProvider.spec.name,
            baseUrl: customProvider.spec.baseUrl,
            apiKey: customProvider.apiKey,
            modelId: selected.upstreamId?.trim() || selected.id,
          };
          const runtimeSpec = codexCustomRuntimeSpec(opts.env ?? {}, binding, true);
          runtimeReservation = runtimeSpec.key;
          reservations.set(runtimeSpec.key, (reservations.get(runtimeSpec.key) ?? 0) + 1);
          try {
            await ensureRuntime({ ...runtimeSpec, providerBaseUrl: binding.baseUrl });
          } catch {
            throw new HarnessModelTestError("runtime_startup_failed", proxy.attempt());
          }
          timer = setTimeout(() => controller.abort(), input.requestTimeoutMs);
          const reply = await single(
            input.systemPrompt,
            input.prompt,
            controller.signal,
            undefined,
            input.model,
            true,
            customProvider,
          );
          return {
            ...(reply ? { reply } : {}),
            maxOutputTokens: input.maxOutputTokens,
            evidence: proxy.evidence(),
          };
        } catch (error) {
          if (error instanceof HarnessModelTestError) throw error;
          throw modelTestError(controller.signal, proxy.attempt());
        } finally {
          if (timer) clearTimeout(timer);
          if (runtimeReservation) await releaseReservation(runtimeReservation);
          await proxy.close();
        }
      },
      judge: (system, prompt) => single(system, prompt, undefined, undefined, judgeModelId),
      screenSecurity: async ({ payload, signal, model, recordModelCall, recordLlmRequest }) =>
        parseSecurityScreenVerdict(
          await single(
            SECURITY_SCREEN_SYSTEM_PROMPT,
            payload,
            signal,
            {
              recordModelCall,
              ...(recordLlmRequest ? { recordLlmRequest } : {}),
            },
            model,
          ),
        ),
      generateTitle: async (input) =>
        sanitizeTitle(
          await single(
            TITLE_GENERATION_PROMPT,
            titleUserPrompt(input.transcript),
            input.signal,
            {
              recordModelCall: input.recordModelCall ?? (() => {}),
              ...(input.recordLlmRequest ? { recordLlmRequest: input.recordLlmRequest } : {}),
            },
            input.model,
          ),
        ),
      summarizeApproval: async (command, reason, purpose) =>
        single(
          "Explain this command in one plain-English sentence for an approver.",
          [command, reason, purpose].filter(Boolean).join("\n"),
        ),
    },
  );
}
