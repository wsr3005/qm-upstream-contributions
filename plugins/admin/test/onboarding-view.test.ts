import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return html.slice(start, end);
}

function resolveView(pathname: string, search: string): string {
  const src = [
    slice("const SECTIONS = [", "const DISABLED_VIEWS"),
    slice("const DEFAULT_VIEW = ", ";") + ";",
    slice("function urlToState() {", "let transcriptObserver"),
    "urlToState().view;",
  ].join("\n");
  const context = vm.createContext({
    URLSearchParams,
    API_BASE: "/admin",
    scope: "org",
    location: { pathname, search },
  });
  return vm.runInContext(src, context);
}

function renderCustomProviderTestResult(data: object, target: object): string {
  const src = slice(
    "function customProviderTestResultText(data, target) {",
    "function syncCustomProviderTestHarnesses()",
  );
  const context = vm.createContext({ data, target });
  return vm.runInContext(`${src}\ncustomProviderTestResultText(data, target);`, context);
}

test("onboarding is a navigable view", () => {
  assert.match(html, /\{ label: "Admin", views: \["onboarding",/);
});

test("/admin/onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/onboarding", ""), "onboarding");
});

test("?view=onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/", "?view=onboarding"), "onboarding");
});

test("unknown views still fall back to the default view", () => {
  assert.equal(resolveView("/admin/no-such-view", ""), "history");
});

test("custom provider setup exposes an explicit paid generation test", () => {
  assert.match(html, /id="custom-provider-test-model"/);
  assert.match(html, /id="custom-provider-test-harness"/);
  assert.match(html, /id="custom-provider-test">Run paid Harness test/);
  assert.match(html, /value="openai">OpenAI Chat Completions/);
  assert.match(html, /value="openai-responses">OpenAI Responses \(Codex-compatible\)/);
  assert.match(html, /at most one real billable model request through the selected Harness/);
  assert.match(html, /Pi is capped at\s+128 output.*OpenCode and Codex use their native runtime limits/s);
  assert.match(html, /Automatic provider retries are\s+disabled/);
  assert.match(html, /modelId: target\.modelId,\s*harness,/);
  assert.match(html, /id="st-custom-provider-test" role="status" aria-live="polite"/);
  assert.match(html, /finally\s*{\s*\$\("custom-provider-test"\)\.disabled = false;/);
});

test("custom provider test success attributes the server-confirmed upstream model", () => {
  const rendered = renderCustomProviderTestResult(
    {
      harness: "codex",
      modelId: "luna",
      upstreamModelId: "wire-new",
      latencyMs: 42,
      reply: "ready",
    },
    { modelId: "luna", upstreamModelId: "wire-old" },
  );
  assert.equal(rendered, "codex · luna → wire-new replied in 42 ms: ready");
  assert.doesNotMatch(rendered, /wire-old/);
});
