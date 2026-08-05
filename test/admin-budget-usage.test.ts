import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start(signingSecret?: string) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-budget-usage-")),
      budgetUsdPerWindow: 2,
      orgBudgetUsdPerWindow: 5,
      budgetWindowMs: 86_400_000,
    }),
  );
  const dependencies = {
    admin: built.admin,
    auditLog: built.auditLog,
    budget: built.budget,
  };
  const server = signingSecret
    ? createServer(built.app, { ...dependencies, signingSecret })
    : createInsecureTestServer(built.app, dependencies);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("org admin reads approximate member and organization budget usage", async () => {
  const s = start();
  try {
    await s.built.budget.record("U1", 0.5);
    await s.built.budget.record("U2", 1.25);
    const url = new URL("/v1/admin/budget-usage", s.base);
    url.searchParams.set("scope", "org:default-org");
    url.searchParams.set("principalId", "U1");
    const response = await fetch(url, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      scopeId: "org:default-org",
      principalId: "U1",
      windowMs: 86_400_000,
      approximate: true,
      member: { spentUsd: 0.5, limitUsd: 2 },
      organization: { spentUsd: 1.75, limitUsd: 5 },
    });
  } finally {
    await s.close();
  }
});

test("budget usage requires and accepts signed source authentication", async () => {
  const secret = "budget-usage-signing-secret".repeat(3);
  const s = start(secret);
  try {
    const path = "/v1/admin/budget-usage?scope=org%3Adefault-org&principalId=U1";
    const unsigned = await fetch(`${s.base}${path}`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(unsigned.status, 401);
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = signRequest(secret, timestamp, `GET\n${path}\n`);
    const signed = await fetch(`${s.base}${path}`, {
      headers: {
        "x-admin-actor": "admin-alice@default-org",
        "x-timestamp": String(timestamp),
        "x-signature": signature,
      },
    });
    assert.equal(signed.status, 200);
  } finally {
    await s.close();
  }
});

test("budget usage rejects non-admins and foreign scopes", async () => {
  const s = start();
  try {
    const own = "/v1/admin/budget-usage?scope=org%3Adefault-org&principalId=U1";
    const denied = await fetch(`${s.base}${own}`, { headers: { "x-admin-actor": "U1@default-org" } });
    assert.equal(denied.status, 403);
    const foreign = await fetch(`${s.base}/v1/admin/budget-usage?scope=org%3Aother-org&principalId=U1`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(foreign.status, 403);
  } finally {
    await s.close();
  }
});
