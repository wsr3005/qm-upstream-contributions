import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

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
  "x-openai-internal-codex-responses-lite",
]);

function headersFromRequest(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (UNFORWARDED_HEADERS.has(name) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function targetUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const target = new URL(baseUrl);
  const request = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${request.pathname.startsWith("/") ? request.pathname : `/${request.pathname}`}`;
  target.search = request.search;
  return target;
}

async function writeResponse(upstream: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!UNFORWARDED_HEADERS.has(name) && name !== "content-encoding" && name !== "location") headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
  }
  res.end();
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function createCodexProviderProxy(baseUrl: string): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    const abortUpstream = () => abort.abort();
    const abortIncompleteResponse = () => {
      if (!res.writableFinished) abort.abort();
    };
    req.once("aborted", abortUpstream);
    req.once("error", abortUpstream);
    res.once("close", abortIncompleteResponse);
    try {
      const method = req.method ?? "GET";
      const upstream = await fetch(targetUrl(baseUrl, req.url), {
        method,
        headers: headersFromRequest(req),
        redirect: "manual",
        ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req), duplex: "half" as const }),
        signal: abort.signal,
      } as RequestInit & { duplex?: "half" });
      await writeResponse(upstream, res);
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502);
        res.end();
      } else if (!res.destroyed) res.destroy();
    } finally {
      req.off("aborted", abortUpstream);
      req.off("error", abortUpstream);
      res.off("close", abortIncompleteResponse);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("failed to bind Codex provider proxy");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
