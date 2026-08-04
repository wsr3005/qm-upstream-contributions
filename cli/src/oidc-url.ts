import { isIP } from "node:net";

export type OidcServerEndpointKind = "token" | "userinfo" | "jwks";

const brokerPaths: Record<OidcServerEndpointKind, string> = {
  token: "/token",
  userinfo: "/userinfo",
  jwks: "/.well-known/jwks.json",
};

function privateIp(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    const octets = hostname.split(".").map(Number);
    return (
      octets[0] === 127 ||
      octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31)
    );
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "0:0:0:0:0:0:0:1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    );
  }
  return false;
}

export function isServiceLocalHostname(hostname: string, declaredServiceHost = ""): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const declared = declaredServiceHost.trim().toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".flycast") ||
    host.endsWith(".local") ||
    privateIp(host) ||
    Boolean(declared && !host.includes(".") && host === declared)
  );
}

export function brokerOrigin(raw: string, declaredServiceHost = ""): string {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !isServiceLocalHostname(url.hostname, declaredServiceHost) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function validHttpsOidcUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function sameOidcUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

export function validOidcServerEndpoint(
  raw: string,
  kind: OidcServerEndpointKind,
  broker: { upstream: string; declaredServiceHost?: string } | null,
): boolean {
  try {
    const url = new URL(raw);
    if (!broker) return validHttpsOidcUrl(raw);
    if (url.username || url.password || url.hash || url.search) return false;
    const expectedOrigin = brokerOrigin(broker.upstream, broker.declaredServiceHost);
    return Boolean(expectedOrigin && url.origin === expectedOrigin && url.pathname === brokerPaths[kind]);
  } catch {
    return false;
  }
}
