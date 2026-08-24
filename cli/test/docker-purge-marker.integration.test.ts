import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { QmConfig } from "../src/config.ts";
import { dockerDown } from "../src/backends/docker.ts";
import { dockerAvailable } from "./e2e/harness.ts";

const skip = dockerAvailable() ? false : "Docker is unavailable";

test("docker purge preserves destroy markers when an external container keeps data in use", { skip }, async () => {
  const orgId = `purge-marker-${process.pid}`;
  const home = `qm-home-${orgId}`;
  const marker = `qm-destroy-${orgId}`;
  const holder = `qm-external-holder-${orgId}`;
  const docker = (args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const config = {
    contract: 1,
    orgId,
    publicUrl: "http://localhost:8080",
    target: "docker",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
  } as QmConfig;
  docker(["volume", "create", "--label", `qm.org=${orgId}`, home]);
  docker(["volume", "create", "--label", `qm.org=${orgId}`, marker]);
  docker(["create", "--name", holder, "-v", `${home}:/data`, "busybox:1.36", "true"]);
  try {
    await assert.rejects(dockerDown(config, { purge: true }), /in use/);
    assert.doesNotThrow(() => docker(["volume", "inspect", marker]));
    assert.doesNotThrow(() => docker(["volume", "inspect", home]));
  } finally {
    try {
      docker(["rm", "-f", holder]);
    } catch (error) {
      void error;
    }
    try {
      docker(["volume", "rm", home]);
    } catch (error) {
      void error;
    }
    try {
      docker(["volume", "rm", marker]);
    } catch (error) {
      void error;
    }
  }
});
