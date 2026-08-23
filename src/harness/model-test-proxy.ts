import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

function requestBody(req: IncomingMessage, max = 16 * 1024 * 1024): Promise<Buffer> {
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

function withoutTools(body: Buffer): Buffer {
  try {
    const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

async function responseBody(response: Response, max = 16 * 1024 * 1024): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) return Buffer.concat(chunks);
    const chunk = Buffer.from(next.value);
    size += chunk.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("upstream response body too large");
    }
    chunks.push(chunk);
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function createModelTestProxy(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let attempted = false;
  const server = createServer(async (req, res) => {
    if (attempted) return json(res, 400, { error: { message: "Model connection test permits one upstream request" } });
    attempted = true;
    try {
      const method = req.method ?? "GET";
      const rawBody = method === "GET" || method === "HEAD" ? undefined : await requestBody(req);
      const upstream = await fetch(upstreamUrl(baseUrl, req.url), {
        method,
        headers: forwardedHeaders(req),
        redirect: "manual",
        ...(rawBody ? { body: withoutTools(rawBody) } : {}),
        ...(signal ? { signal } : {}),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return json(res, 400, { error: { message: `Upstream model test rejected HTTP ${upstream.status} redirect` } });
      }
      if (upstream.status === 408 || upstream.status === 409 || upstream.status === 429 || upstream.status >= 500) {
        await upstream.body?.cancel();
        return json(res, 400, { error: { message: `Upstream model test failed with HTTP ${upstream.status}` } });
      }
      const body = await responseBody(upstream);
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!UNFORWARDED_HEADERS.has(name) && name !== "content-encoding" && name !== "location") {
          headers[name] = value;
        }
      });
      res.writeHead(upstream.status, headers);
      res.end(body);
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
    close: () => closeServer(server),
  };
}
