import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("web UI deploy image includes build scripts", () => {
  const dockerfile = readFileSync(join(repoRoot, "deploy/web-ui/Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY plugins\/web-ui\/scripts \.\/scripts/);
});
