import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ModelTestUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelTestProxyEvidence {
  requestedModel: string;
  responseModel: string;
  firstTokenMs: number;
  totalMs: number;
  usage: ModelTestUsage;
  streamed: boolean;
  upstreamRequests: number;
}

export interface ModelTestProxyAttempt {
  upstreamRequests: number;
  responseCompleted: boolean;
  upstreamStatus?: number;
  evidence?: ModelTestProxyEvidence;
}

export const MODEL_TEST_MAX_OUTPUT_TOKENS = 128;
const MODEL_TEST_MAX_REQUEST_BYTES = 512 * 1024;

const UNFORWARDED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function requestBody(req: IncomingMessage, max = MODEL_TEST_MAX_REQUEST_BYTES): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
    req.resume();
  });
}

function forwardedHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (UNFORWARDED_HEADERS.has(name) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function upstreamUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const target = new URL(baseUrl);
  const request = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${request.pathname.startsWith("/") ? request.pathname : `/${request.pathname}`}`;
  target.search = request.search;
  return target;
}

function outputLimit(value: unknown, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : maximum;
}

function preparedBody(
  body: Buffer,
  requestUrl: string | undefined,
  expectedModel: string,
  maxOutputTokens: number,
): { body: string; requestedModel: string | null } {
  try {
    const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
    const requestedModel = typeof payload.model === "string" ? payload.model : null;
    const pathname = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
    if (pathname.endsWith("/responses")) {
      payload.max_output_tokens = outputLimit(payload.max_output_tokens, maxOutputTokens);
    } else if (pathname.endsWith("/chat/completions")) {
      if ("max_completion_tokens" in payload) {
        payload.max_completion_tokens = outputLimit(payload.max_completion_tokens, maxOutputTokens);
      }
      if ("max_tokens" in payload || !("max_completion_tokens" in payload)) {
        payload.max_tokens = outputLimit(payload.max_tokens, maxOutputTokens);
      }
      if (payload.stream === true) {
        const streamOptions =
          payload.stream_options && typeof payload.stream_options === "object"
            ? (payload.stream_options as Record<string, unknown>)
            : {};
        payload.stream_options = { ...streamOptions, include_usage: true };
      }
    } else if (pathname.endsWith("/messages")) {
      payload.max_tokens = outputLimit(payload.max_tokens, maxOutputTokens);
    }
    return {
      body: JSON.stringify(payload),
      requestedModel: requestedModel === expectedModel ? requestedModel : null,
    };
  } catch {
    return { body: body.toString("utf8"), requestedModel: null };
  }
}

type PartialModelTestUsage = Partial<ModelTestUsage>;

interface UsageAccumulator extends PartialModelTestUsage {
  invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function integerFromFields(fields: Array<[Record<string, unknown>, string]>): {
  present: boolean;
  valid: boolean;
  value?: number;
} {
  const values: number[] = [];
  for (const [record, key] of fields) {
    if (!hasOwn(record, key)) continue;
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return { present: true, valid: false };
    }
    values.push(value);
  }
  if (!values.length) return { present: false, valid: true };
  if (values.some((value) => value !== values[0])) return { present: true, valid: false };
  return { present: true, valid: true, value: values[0] };
}

function partialUsage(value: Record<string, unknown>): { valid: boolean; usage?: PartialModelTestUsage } {
  const input = integerFromFields([
    [value, "input_tokens"],
    [value, "prompt_tokens"],
    [value, "inputTokens"],
  ]);
  const output = integerFromFields([
    [value, "output_tokens"],
    [value, "completion_tokens"],
    [value, "outputTokens"],
  ]);
  const total = integerFromFields([
    [value, "total_tokens"],
    [value, "totalTokens"],
  ]);
  const cachedFields: Array<[Record<string, unknown>, string]> = [
    [value, "cached_input_tokens"],
    [value, "cache_read_input_tokens"],
  ];
  for (const key of ["input_tokens_details", "prompt_tokens_details"]) {
    if (!hasOwn(value, key)) continue;
    const details = value[key];
    if (!isRecord(details)) return { valid: false };
    cachedFields.push([details, "cached_tokens"]);
  }
  const cached = integerFromFields(cachedFields);
  const cacheCreation = integerFromFields([[value, "cache_creation_input_tokens"]]);
  const fields = [input, output, total, cached, cacheCreation];
  if (fields.some((field) => !field.valid) || fields.every((field) => !field.present)) {
    return { valid: false };
  }
  return {
    valid: true,
    usage: {
      ...(input.present ? { inputTokens: input.value } : {}),
      ...(output.present ? { outputTokens: output.value } : {}),
      ...(total.present ? { totalTokens: total.value } : {}),
      ...(cached.present ? { cachedInputTokens: cached.value } : {}),
      ...(cacheCreation.present ? { cacheCreationInputTokens: cacheCreation.value } : {}),
    },
  };
}

function payloadRoots(payload: Record<string, unknown>): Record<string, unknown>[] {
  const roots = [payload];
  if (isRecord(payload.response)) roots.push(payload.response);
  if (isRecord(payload.message)) roots.push(payload.message);
  if (isRecord(payload.response) && isRecord(payload.response.message)) roots.push(payload.response.message);
  return [...new Set(roots)];
}

function usageFromPayload(payload: Record<string, unknown>): { invalid: boolean; values: PartialModelTestUsage[] } {
  const values: PartialModelTestUsage[] = [];
  const seen = new Set<Record<string, unknown>>();
  let invalid = false;
  for (const root of payloadRoots(payload)) {
    if (!hasOwn(root, "usage")) continue;
    const candidate = root.usage;
    if (candidate === null || candidate === undefined) continue;
    if (!isRecord(candidate)) {
      invalid = true;
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const parsed = partialUsage(candidate);
    if (!parsed.valid || !parsed.usage) invalid = true;
    else values.push(parsed.usage);
  }
  return { invalid, values };
}

function modelsFromPayload(payload: Record<string, unknown>): { invalid: boolean; values: string[] } {
  const values: string[] = [];
  let invalid = false;
  for (const root of payloadRoots(payload)) {
    if (!hasOwn(root, "model")) continue;
    const model = root.model;
    if (typeof model !== "string" || !model || model.trim() !== model) invalid = true;
    else values.push(model);
  }
  return { invalid, values };
}

function mergeUsage(accumulator: UsageAccumulator, usage: PartialModelTestUsage, maxOutputTokens: number): void {
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheCreationInputTokens",
  ] as const) {
    const next = usage[key];
    if (next === undefined) continue;
    const current = accumulator[key];
    if (current !== undefined && next < current) accumulator.invalid = true;
    else accumulator[key] = next;
  }
  if (accumulator.outputTokens !== undefined && accumulator.outputTokens > maxOutputTokens) {
    accumulator.invalid = true;
  }
}

function completeUsage(accumulator: UsageAccumulator, anthropic: boolean): ModelTestUsage | null {
  if (accumulator.invalid || accumulator.inputTokens === undefined || accumulator.outputTokens === undefined) {
    return null;
  }
  const cachedInputTokens = accumulator.cachedInputTokens ?? 0;
  const cacheCreationInputTokens = accumulator.cacheCreationInputTokens ?? 0;
  if (!anthropic && cacheCreationInputTokens !== 0) return null;
  const inputTokens = anthropic
    ? accumulator.inputTokens + cachedInputTokens + cacheCreationInputTokens
    : accumulator.inputTokens;
  if (!Number.isSafeInteger(inputTokens)) return null;
  const totalTokens = accumulator.totalTokens ?? inputTokens + accumulator.outputTokens;
  const usage = {
    inputTokens,
    outputTokens: accumulator.outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
  };
  return validUsage(usage, Number.MAX_SAFE_INTEGER) ? usage : null;
}

function validUsage(usage: unknown, maxOutputTokens: number): usage is ModelTestUsage {
  if (!isRecord(usage)) return false;
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    (usage.inputTokens as number) > 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    (usage.outputTokens as number) > 0 &&
    (usage.outputTokens as number) <= maxOutputTokens &&
    Number.isSafeInteger(usage.totalTokens) &&
    (usage.totalTokens as number) >= (usage.inputTokens as number) + (usage.outputTokens as number) &&
    Number.isSafeInteger(usage.cachedInputTokens) &&
    (usage.cachedInputTokens as number) >= 0 &&
    Number.isSafeInteger(usage.cacheCreationInputTokens) &&
    (usage.cacheCreationInputTokens as number) >= 0 &&
    (usage.cachedInputTokens as number) + (usage.cacheCreationInputTokens as number) <= (usage.inputTokens as number)
  );
}

export function isValidModelTestProxyEvidence(
  evidence: unknown,
  expectedModel: string,
  maxOutputTokens: number,
): evidence is ModelTestProxyEvidence {
  if (!isRecord(evidence)) return false;
  return (
    evidence.requestedModel === expectedModel &&
    evidence.responseModel === expectedModel &&
    Number.isSafeInteger(evidence.firstTokenMs) &&
    (evidence.firstTokenMs as number) > 0 &&
    Number.isSafeInteger(evidence.totalMs) &&
    (evidence.totalMs as number) >= (evidence.firstTokenMs as number) &&
    validUsage(evidence.usage, maxOutputTokens) &&
    evidence.streamed === true &&
    evidence.upstreamRequests === 1
  );
}

function textDelta(payload: Record<string, unknown>): string {
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") return payload.delta;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object") continue;
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === "string" && content) return content;
  }
  const delta = payload.delta;
  if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).text === "string") {
    return (delta as Record<string, unknown>).text as string;
  }
  return "";
}

function writeChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolveWrite, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolveWrite();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("model test client disconnected"));
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}

function createResponseObserver(startedAt: number, streamed: boolean, maxOutputTokens: number, anthropic: boolean) {
  const decoder = new TextDecoder();
  const chunks: Buffer[] = [];
  const responseModels = new Set<string>();
  const usage: UsageAccumulator = { invalid: false };
  let pending = "";
  let size = 0;
  let firstTokenAt: number | null = null;
  let invalidPayload = false;
  let invalidModel = false;
  const observePayload = (payload: Record<string, unknown>, at: number) => {
    const observedModels = modelsFromPayload(payload);
    invalidModel ||= observedModels.invalid;
    for (const model of observedModels.values) responseModels.add(model);
    const observedUsage = usageFromPayload(payload);
    usage.invalid ||= observedUsage.invalid;
    for (const value of observedUsage.values) mergeUsage(usage, value, maxOutputTokens);
    if (!firstTokenAt && textDelta(payload)) firstTokenAt = at;
  };
  const drainEvents = (at: number, final: boolean) => {
    while (pending) {
      const delimiter = /\r?\n\r?\n/.exec(pending);
      if (!delimiter && !final) return;
      const end = delimiter?.index ?? pending.length;
      const block = pending.slice(0, end);
      pending = delimiter ? pending.slice(end + delimiter[0].length) : "";
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data) as unknown;
        if (!isRecord(payload)) invalidPayload = true;
        else observePayload(payload, at);
      } catch {
        invalidPayload = true;
      }
    }
  };
  return {
    async observe(chunk: Buffer, at: number, max: number): Promise<void> {
      size += chunk.length;
      if (size > max) throw new Error("upstream response body too large");
      chunks.push(chunk);
      if (!streamed) {
        firstTokenAt ??= at;
        return;
      }
      pending += decoder.decode(chunk, { stream: true });
      drainEvents(at, false);
    },
    finish(at: number): Omit<ModelTestProxyEvidence, "requestedModel" | "upstreamRequests"> | null {
      if (streamed) {
        pending += decoder.decode();
        drainEvents(at, true);
      } else {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (!isRecord(payload)) return null;
          observePayload(payload, at);
        } catch {
          return null;
        }
      }
      const observedUsage = completeUsage(usage, anthropic);
      const responseModel = responseModels.size === 1 ? responseModels.values().next().value : undefined;
      if (invalidPayload || invalidModel || !responseModel || !observedUsage || !firstTokenAt) return null;
      return {
        responseModel,
        firstTokenMs: Math.max(1, firstTokenAt - startedAt),
        totalMs: Math.max(1, at - startedAt),
        usage: observedUsage,
        streamed,
      };
    },
  };
}

async function forwardResponseBody(
  response: Response,
  res: ServerResponse,
  startedAt: number,
  streamed: boolean,
  maxOutputTokens: number,
  anthropic: boolean,
  max = 16 * 1024 * 1024,
): Promise<Omit<ModelTestProxyEvidence, "requestedModel" | "upstreamRequests"> | null> {
  if (!response.body) return null;
  const observer = createResponseObserver(startedAt, streamed, maxOutputTokens, anthropic);
  const reader = response.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) {
      return observer.finish(Date.now());
    }
    const chunk = Buffer.from(next.value);
    try {
      await observer.observe(chunk, Date.now(), max);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    await writeChunk(res, chunk);
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function createModelTestProxy(
  baseUrl: string,
  options: { signal?: AbortSignal; expectedModel: string; maxOutputTokens: number },
): Promise<{
  baseUrl: string;
  attempt(): ModelTestProxyAttempt;
  evidence(): ModelTestProxyEvidence;
  close(): Promise<void>;
}> {
  let attempted = false;
  let upstreamRequests = 0;
  let responseCompleted = false;
  let upstreamStatus: number | undefined;
  let evidence: ModelTestProxyEvidence | null = null;
  const server = createServer(async (req, res) => {
    if (attempted) return json(res, 400, { error: { message: "Model connection test permits one upstream request" } });
    attempted = true;
    try {
      const method = req.method ?? "GET";
      const rawBody = method === "GET" || method === "HEAD" ? undefined : await requestBody(req);
      const prepared = rawBody
        ? preparedBody(rawBody, req.url, options.expectedModel, options.maxOutputTokens)
        : { body: undefined, requestedModel: null };
      if (prepared.requestedModel !== options.expectedModel) {
        return json(res, 400, { error: { message: "Model connection test refused an unexpected model id" } });
      }
      const startedAt = Date.now();
      upstreamRequests += 1;
      const upstream = await fetch(upstreamUrl(baseUrl, req.url), {
        method,
        headers: forwardedHeaders(req),
        redirect: "manual",
        ...(prepared.body ? { body: prepared.body } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      upstreamStatus = upstream.status;
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return json(res, 400, { error: { message: `Upstream model test rejected HTTP ${upstream.status} redirect` } });
      }
      if (upstream.status === 408 || upstream.status === 409 || upstream.status === 429 || upstream.status >= 500) {
        await upstream.body?.cancel();
        return json(res, 400, { error: { message: `Upstream model test failed with HTTP ${upstream.status}` } });
      }
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!UNFORWARDED_HEADERS.has(name) && name !== "content-encoding" && name !== "location") {
          headers[name] = value;
        }
      });
      res.writeHead(upstream.status, headers);
      const observed = await forwardResponseBody(
        upstream,
        res,
        startedAt,
        upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false,
        options.maxOutputTokens,
        new URL(req.url ?? "/", "http://127.0.0.1").pathname.endsWith("/messages"),
      );
      responseCompleted = true;
      evidence = observed ? { ...observed, requestedModel: options.expectedModel, upstreamRequests } : null;
      res.end();
    } catch {
      if (!res.headersSent && !res.destroyed)
        json(res, 400, { error: { message: "Upstream model test request failed" } });
      else res.destroy();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("failed to bind model test proxy");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    attempt: () => ({
      upstreamRequests,
      responseCompleted,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      ...(evidence ? { evidence } : {}),
    }),
    evidence: () => {
      if (!isValidModelTestProxyEvidence(evidence, options.expectedModel, options.maxOutputTokens)) {
        throw new Error("model test response evidence did not match the requested model");
      }
      return evidence;
    },
    close: () => closeServer(server),
  };
}
