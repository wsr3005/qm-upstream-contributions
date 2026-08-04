import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { createBudgetTracker } from "../src/ratelimit/budget.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("budget usage is current, org-admin gated, and audited", async () => {
  const built = buildApp(testConfig());
  const budget = createBudgetTracker({ limitUsd: 5, orgLimitUsd: 20, windowMs: 86_400_000 });
  const now = Date.now();
  await budget.record("U1", 2, now - 1_000);
  await budget.record("U2", 3, now - 1_000);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    budget,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(
      `${base}/v1/budget-usage?scope=org:default-org&principalId=U1`,
      { headers: { "x-admin-actor": "admin-alice@default-org" } },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      scopeId: "org:default-org",
      principalId: "U1",
      windowMs: 86_400_000,
      member: { spentUsd: 2, limitUsd: 5 },
      organization: { spentUsd: 5, limitUsd: 20 },
      approximate: true,
    });
    assert.equal(
      (
        await fetch(`${base}/v1/budget-usage?scope=org:default-org&principalId=U1`, {
          headers: { "x-admin-actor": "user-uma@default-org" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/budget-usage?scope=org:other&principalId=U1`, {
          headers: { "x-admin-actor": "admin-alice@default-org" },
        })
      ).status,
      400,
    );
    assert.ok((await built.auditLog.events()).some((event) => event.action === "budget-usage.read"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("budget usage drops spend outside the configured window", async () => {
  const budget = createBudgetTracker({ limitUsd: 5, orgLimitUsd: 20, windowMs: 1_000 });
  await budget.record("U1", 2, 1_000);
  assert.deepEqual(await budget.snapshot("U1", 2_001), {
    windowMs: 1_000,
    member: { spentUsd: 0, limitUsd: 5 },
    organization: { spentUsd: 0, limitUsd: 20 },
  });
});

test("budget usage requires source authentication and an organization administrator", async () => {
  const secret = "budget-usage-source-secret".repeat(3);
  const capabilitySecret = "budget-usage-capability-secret".repeat(3);
  const portalIdentitySecret = "budget-usage-portal-secret".repeat(3);
  const built = buildApp(testConfig({ signingSecret: secret }));
  const budget = createBudgetTracker({ limitUsd: 5, orgLimitUsd: 20 });
  const server = createServer(built.app, {
    production: true,
    signingSecret: secret,
    capabilitySecret,
    portalIdentitySecret,
    admin: built.admin,
    auditLog: built.auditLog,
    budget,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const path = "/v1/budget-usage?scope=org:default-org&principalId=U1";
  try {
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal(
      (
        await fetch(base + path, {
          headers: { ...signedHeaders(secret, "GET", path, ""), "x-admin-actor": "user-uma@default-org" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + path, {
          headers: { ...signedHeaders(secret, "GET", path, ""), "x-admin-actor": "admin-alice@default-org" },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("unconfigured limits are explicit and failed reads remain audited", async () => {
  const built = buildApp(testConfig());
  const unbounded = createBudgetTracker();
  const first = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    budget: unbounded,
  });
  first.listen(0);
  const path = "/v1/budget-usage?scope=org:default-org&principalId=U1";
  try {
    const response = await fetch(`http://localhost:${(first.address() as AddressInfo).port}${path}`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      member: { limitUsd: number | null };
      organization: { limitUsd: number | null };
    };
    assert.equal(body.member.limitUsd, null);
    assert.equal(body.organization.limitUsd, null);
  } finally {
    await new Promise<void>((resolve) => first.close(() => resolve()));
  }

  const failing = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    budget: {
      check: () => Promise.reject(new Error("unused")),
      record: () => Promise.reject(new Error("unused")),
      snapshot: () => Promise.reject(new Error("database unavailable")),
    },
  });
  failing.listen(0);
  try {
    const response = await fetch(`http://localhost:${(failing.address() as AddressInfo).port}${path}`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(response.status, 500);
    const reads = (await built.auditLog.events()).filter((event) => event.action === "budget-usage.read");
    assert.equal(reads.length, 2);
  } finally {
    await new Promise<void>((resolve) => failing.close(() => resolve()));
  }
});
