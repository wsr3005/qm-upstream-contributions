import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the signed core image receives the release commit as GIT_SHA", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-package.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /- name: core\s+dockerfile: deploy\/core\/Dockerfile\s+build-args: GIT_SHA=\$\{\{ github\.sha \}\}/,
  );
});
