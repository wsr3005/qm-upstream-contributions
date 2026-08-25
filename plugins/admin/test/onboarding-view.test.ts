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
  const src = slice("function customProviderTestEvidenceText(data) {", "function syncCustomProviderTestHarnesses()");
  const context = vm.createContext({ data, target });
  return vm.runInContext(`${src}\ncustomProviderTestResultText(data, target);`, context);
}

type ApiResponse = { ok: boolean; status?: number; data?: Record<string, unknown> };
type ApiHandler = (method: string, path: string, body?: unknown) => Promise<ApiResponse>;

const TEST_MODEL_EVIDENCE = {
  requestedModel: "gpt-5.6-luna",
  responseModel: "gpt-5.6-luna",
  endpointAlias: "Gateway",
  firstTokenMs: 12,
  providerTotalMs: 40,
  usage: {
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  streamed: true,
  upstreamRequests: 1,
  noDefaultEgress: true,
  maxOutputTokens: 128,
};

function successfulHarnessResponse(requestId: string, overrides: Record<string, unknown> = {}): ApiResponse {
  return {
    ok: true,
    status: 200,
    data: {
      ok: true,
      requestId,
      providerId: "gateway",
      modelId: "luna",
      upstreamModelId: "gpt-5.6-luna",
      harness: "pi",
      reply: "ready",
      latencyMs: 42,
      ...TEST_MODEL_EVIDENCE,
      providerRevision: 1,
      testedAt: Date.UTC(2026, 7, 24),
      ...overrides,
    },
  };
}

type FakeElement = {
  tagName: string;
  value: string;
  textContent: string;
  className: string;
  disabled: boolean;
  hidden: boolean;
  checked: boolean;
  placeholder: string;
  options: FakeElement[];
  children: FakeElement[];
  selectedOptions: FakeElement[];
  onclick?: () => unknown;
  onchange?: () => unknown;
  appendChild(child: FakeElement): FakeElement;
  append(...children: FakeElement[]): void;
};

function fakeElement(tagName = "div"): FakeElement {
  let textContent = "";
  const element = {
    tagName,
    value: "",
    textContent: "",
    className: "",
    disabled: false,
    hidden: false,
    checked: false,
    placeholder: "",
    options: [],
    children: [],
    selectedOptions: [],
    appendChild(child: FakeElement) {
      this.children.push(child);
      if (this.tagName === "select") {
        this.options.push(child);
        if (this.options.length === 1) this.value = child.value;
      }
      return child;
    },
    append(...children: FakeElement[]) {
      children.forEach((child) => this.appendChild(child));
    },
  } as FakeElement;
  Object.defineProperty(element, "textContent", {
    get: () => textContent,
    set: (value: string) => {
      textContent = value;
      if (value === "") {
        element.children.length = 0;
        if (tagName === "select") {
          element.options.length = 0;
          element.value = "";
        }
      }
    },
  });
  Object.defineProperty(element, "selectedOptions", {
    get: () => element.options.filter((option) => option.value === element.value).slice(0, 1),
  });
  return element;
}

function customProvider(updatedAt: number, models = ["luna"]): Record<string, unknown> {
  return {
    id: "gateway",
    name: "Gateway",
    protocol: "openai-responses",
    baseUrl: "https://models.example/v1",
    hasKey: true,
    disabled: false,
    revision: updatedAt,
    updatedAt,
    updatedBy: "admin",
    models: models.map((id) => ({ id, upstreamId: "gpt-5.6-" + id })),
  };
}

let nextFakeRequestId = 0;

function createCustomProviderUi(
  initialApi: ApiHandler,
  retryStorage = new Map<string, string>(),
  storageFailure: { get?: boolean; remove?: boolean; set?: boolean } = {},
) {
  const elements = new Map<string, FakeElement>();
  const element = (id: string, tagName = "div") => {
    if (!elements.has(id)) elements.set(id, fakeElement(tagName));
    return elements.get(id)!;
  };
  const modelSelect = element("custom-provider-test-model", "select");
  const harnessSelect = element("custom-provider-test-harness", "select");
  modelSelect.disabled = true;
  harnessSelect.disabled = true;
  ["pi", "opencode", "codex"].forEach((value) => {
    const option = fakeElement("option");
    option.value = value;
    harnessSelect.appendChild(option);
  });
  harnessSelect.value = "pi";
  element("custom-provider-test", "button").disabled = true;
  element("custom-provider-rows", "tbody");
  element("custom-provider-empty");
  element("custom-provider-save", "button");
  element("custom-provider-id", "input");
  element("custom-provider-name", "input");
  element("custom-provider-protocol", "select").value = "openai-responses";
  element("custom-provider-url", "input");
  element("custom-provider-key", "input");
  element("custom-provider-models", "textarea");
  element("custom-provider-validate", "input").checked = true;
  element("st-custom-provider");
  element("st-custom-provider-test");
  const statuses: Array<{ id: string; message: string; kind: string; sticky: boolean }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let apiHandler = initialApi;
  const source = slice("let customProvidersLoaded = [];", "function openOnboardingTarget(target) {");
  const context = vm.createContext({
    $: (id: string) => element(id),
    api: (method: string, path: string, body?: unknown) => apiHandler(method, path, body),
    crypto: { randomUUID: () => `request-${++nextFakeRequestId}` },
    confirm: () => true,
    document: { createElement: (tagName: string) => fakeElement(tagName) },
    localStorage: {
      getItem: (key: string) => {
        if (storageFailure.get) throw new Error("storage unavailable");
        return retryStorage.get(key) ?? null;
      },
      removeItem: (key: string) => {
        if (storageFailure.remove) throw new Error("storage unavailable");
        return retryStorage.delete(key);
      },
      setItem: (key: string, value: string) => {
        if (storageFailure.set) throw new Error("storage unavailable");
        retryStorage.set(key, value);
      },
    },
    orgScope: () => "org:acme",
    clearTimeout: (id: number) => timers.delete(id),
    setTimeout: (callback: () => void) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    setStatus: (id: string, message: string, kind: string, sticky = false) => {
      const target = element(id);
      target.textContent = message;
      target.className = "status " + (kind || "");
      statuses.push({ id, message, kind, sticky });
    },
  });
  const ui = vm.runInContext(
    `${source}\n({
      loadCustomProviders,
      runTest: () => $("custom-provider-test").onclick(),
      saveProvider: () => $("custom-provider-save").onclick(),
    });`,
    context,
  ) as {
    loadCustomProviders(): Promise<boolean>;
    runTest(): Promise<void>;
    saveProvider(): Promise<void>;
  };
  return {
    ui,
    modelSelect,
    harnessSelect,
    testButton: element("custom-provider-test"),
    providerSave: element("custom-provider-save"),
    providerInputs: [
      element("custom-provider-id"),
      element("custom-provider-name"),
      element("custom-provider-protocol"),
      element("custom-provider-url"),
      element("custom-provider-key"),
      element("custom-provider-models"),
      element("custom-provider-validate"),
    ],
    providerStatus: element("st-custom-provider"),
    testStatus: element("st-custom-provider-test"),
    providerRows: element("custom-provider-rows"),
    retryStorage,
    statuses,
    fireTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    setProviderForm(modelLine = "luna | Luna | 1000 | 128 | gpt-5.6-luna | text,image", apiKey = "") {
      element("custom-provider-id").value = "gateway";
      element("custom-provider-name").value = "Gateway";
      element("custom-provider-url").value = "https://models.example/v1";
      element("custom-provider-models").value = modelLine;
      element("custom-provider-key").value = apiKey;
    },
    setApi(handler: ApiHandler) {
      apiHandler = handler;
    },
  };
}

async function onboardingCustomProviderLoadsWhenSetupFails(apiHandler: ApiHandler): Promise<number> {
  let customProviderLoads = 0;
  const source = slice("async function loadOnboarding() {", '$("onboarding-model-provider").onchange');
  const context = vm.createContext({
    api: apiHandler,
    encodeURIComponent,
    loadCustomProviders: async () => {
      customProviderLoads += 1;
      return true;
    },
    orgScope: () => "org:acme",
    renderOnboardingProviderOptions: () => undefined,
    setStatus: () => undefined,
  });
  await (vm.runInContext(`${source}\nloadOnboarding();`, context) as Promise<void>);
  return customProviderLoads;
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
  assert.match(html, /id="custom-provider-test-model" disabled/);
  assert.match(html, /id="custom-provider-test-harness" disabled/);
  assert.match(html, /id="custom-provider-test" disabled>Run paid Harness test/);
  assert.match(html, /value="openai">OpenAI Chat Completions/);
  assert.match(html, /value="openai-responses">OpenAI Responses \(Codex-compatible\)/);
  assert.match(html, /at most one real billable model request through the selected Harness/);
  assert.match(html, /caps every\s+Harness at 128 output tokens/s);
  assert.match(html, /first-token and total latency, streaming status, and\s+token usage/s);
  assert.match(html, /Automatic provider retries are\s+disabled/);
  assert.match(html, /Each click starts a new test/);
  assert.match(html, /same durable request receipt for five minutes without another model charge/);
  assert.match(html, /modelId: target\.modelId,\s*harness,\s*requestId,/);
  assert.match(html, /id="st-custom-provider"\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"/);
  assert.match(html, /id="st-custom-provider-test" role="status" aria-live="polite"/);
  assert.match(html, /const resultText = customProviderTestResultText\(tested\.data, target\);/);
  assert.match(html, /await loadCustomProviders\(\);\s+showCustomProviderTestStatus\(resultText, "ok"\);/);
  assert.match(html, /providerName:\s*name,/);
  assert.match(html, /target\.draft \? " \(current form\)" : ""/);
});

test("custom provider current form tests the default gpt-5.6-luna model before save", async () => {
  let posted: unknown;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [] } };
    posted = body;
    return successfulHarnessResponse((body as { requestId: string }).requestId, {
      modelId: "gpt-5.6-luna",
      providerRevision: 0,
    });
  });
  harness.setProviderForm("gpt-5.6-luna | GPT 5.6 Luna", "sk-draft-secret");
  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.deepEqual(JSON.parse(JSON.stringify((posted as { draft: unknown }).draft)), {
    name: "Gateway",
    protocol: "openai-responses",
    baseUrl: "https://models.example/v1",
    apiKey: "sk-draft-secret",
    models: [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna" }],
  });
  assert.match(harness.testStatus.textContent, /Gateway endpoint · pi · gpt-5\.6-luna/);
});

test("custom providers load once when an unrelated onboarding request fails", async () => {
  const failedResponseLoads = await onboardingCustomProviderLoadsWhenSetupFails(async (_method, path) => ({
    ok: path !== "/api/slack-installation",
    data: {},
  }));
  assert.equal(failedResponseLoads, 1);

  const networkFailureLoads = await onboardingCustomProviderLoadsWhenSetupFails(async (_method, path) => {
    if (path === "/api/connector-catalog") throw new Error("offline");
    return { ok: true, data: {} };
  });
  assert.equal(networkFailureLoads, 1);
});

test("custom provider paid test stays locked across refresh and rejects a duplicate run", async () => {
  let postCalls = 0;
  let postRequestId = "";
  let getCalls = 0;
  let resolvePost!: (response: ApiResponse) => void;
  let resolveCompletionRefresh!: (response: ApiResponse) => void;
  let markCompletionRefreshStarted!: () => void;
  const delayedPost = new Promise<ApiResponse>((resolve) => {
    resolvePost = resolve;
  });
  const delayedCompletionRefresh = new Promise<ApiResponse>((resolve) => {
    resolveCompletionRefresh = resolve;
  });
  const completionRefreshStarted = new Promise<void>((resolve) => {
    markCompletionRefreshStarted = resolve;
  });
  const listing = { ok: true, data: { providers: [customProvider(1)] } };
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") {
      getCalls += 1;
      if (getCalls === 3) {
        markCompletionRefreshStarted();
        return delayedCompletionRefresh;
      }
      return listing;
    }
    postCalls += 1;
    postRequestId = (body as { requestId: string }).requestId;
    return delayedPost;
  });

  await harness.ui.loadCustomProviders();
  assert.equal(harness.testButton.disabled, false);
  const running = harness.ui.runTest();
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.modelSelect.disabled, true);
  assert.equal(harness.harnessSelect.disabled, true);
  assert.equal(harness.providerSave.disabled, true);
  assert.ok(harness.providerInputs.every((input) => input.disabled));
  let actions = harness.providerRows.children[0]?.children.at(-1);
  assert.ok(actions?.children.every((button) => button.disabled));
  harness.providerInputs[1].value = "Keep this form";
  await actions?.children[0]?.onclick?.();
  assert.equal(harness.providerInputs[1].value, "Keep this form");
  assert.equal(postCalls, 1);
  await harness.ui.loadCustomProviders();
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.modelSelect.disabled, true);
  assert.equal(harness.harnessSelect.disabled, true);
  actions = harness.providerRows.children[0]?.children.at(-1);
  assert.ok(actions?.children.every((button) => button.disabled));
  await harness.ui.runTest();
  assert.equal(postCalls, 1);

  resolvePost(successfulHarnessResponse(postRequestId));
  await completionRefreshStarted;
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.providerSave.disabled, true);
  assert.ok(harness.providerInputs.every((input) => input.disabled));
  assert.ok(actions?.children.every((button) => button.disabled));
  resolveCompletionRefresh(listing);
  await running;
  assert.equal(harness.testButton.disabled, false);
  assert.equal(harness.modelSelect.disabled, false);
  assert.equal(harness.harnessSelect.disabled, false);
  assert.equal(harness.providerSave.disabled, false);
  assert.ok(harness.providerInputs.every((input) => !input.disabled));
  assert.match(
    harness.testStatus.textContent,
    /Gateway endpoint · pi · luna · requested gpt-5\.6-luna · response gpt-5\.6-luna\nFirst token 12 ms · provider 40 ms · total 42 ms · stream verified · custom endpoint verified\nUsage 5 input \/ 3 output \/ 8 total · cache read 0 \/ cache write 0 · output cap 128 · generation verified$/,
  );
  assert.equal(harness.statuses.at(-1)?.sticky, true);
});

test("custom provider load errors clear after a successful refresh", async () => {
  let fails = true;
  const harness = createCustomProviderUi(async () =>
    fails
      ? { ok: false, data: { message: "temporary failure" } }
      : { ok: true, data: { providers: [customProvider(1)] } },
  );

  assert.equal(await harness.ui.loadCustomProviders(), false);
  assert.equal(harness.providerStatus.textContent, "temporary failure");
  fails = false;
  assert.equal(await harness.ui.loadCustomProviders(), true);
  assert.equal(harness.providerStatus.textContent, "");
  assert.equal(harness.testButton.disabled, false);
});

test("custom provider save does not overwrite a failed refresh with a success", async () => {
  let savedBody: unknown;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "PUT") {
      savedBody = body;
      return { ok: true, data: {} };
    }
    return { ok: false, data: { message: "refresh failed" } };
  });
  harness.setProviderForm();

  await harness.ui.saveProvider();

  assert.deepEqual(JSON.parse(JSON.stringify((savedBody as { models: unknown }).models)), [
    {
      id: "luna",
      name: "Luna",
      contextWindow: 1000,
      maxTokens: 128,
      upstreamId: "gpt-5.6-luna",
      inputModalities: ["text", "image"],
    },
  ]);
  assert.equal(harness.providerStatus.textContent, "refresh failed");
  assert.equal(harness.providerStatus.className, "status err");
});

test("custom provider removal does not overwrite a failed refresh with a success", async () => {
  let listingCalls = 0;
  const harness = createCustomProviderUi(async (method) => {
    if (method === "DELETE") return { ok: true, data: {} };
    listingCalls += 1;
    return listingCalls === 1
      ? { ok: true, data: { providers: [customProvider(1)] } }
      : { ok: false, data: { message: "refresh failed" } };
  });
  await harness.ui.loadCustomProviders();
  const row = harness.providerRows.children[0];
  const actions = row?.children.at(-1);
  const remove = actions?.children.at(-1);
  assert.ok(remove?.onclick);

  await remove.onclick();

  assert.equal(harness.providerStatus.textContent, "refresh failed");
  assert.equal(harness.providerStatus.className, "status err");
});

test("custom provider network retry reuses its request receipt, then a new click gets a new receipt", async () => {
  const requestIds: string[] = [];
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    requestIds.push((body as { requestId: string }).requestId);
    if (posts === 1) throw new Error("response lost");
    return successfulHarnessResponse(requestIds.at(-1)!);
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  harness.fireTimers();
  await harness.ui.runTest();
  await harness.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.notEqual(requestIds[1], requestIds[2]);
});

test("custom provider response-loss receipt survives a page reload", async () => {
  const retryStorage = new Map<string, string>();
  const requestIds: string[] = [];
  const first = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    requestIds.push((body as { requestId: string }).requestId);
    throw new Error("response lost");
  }, retryStorage);
  await first.ui.loadCustomProviders();
  await first.ui.runTest();
  assert.doesNotMatch([...retryStorage.values()].join(""), /models\.example/);

  const reloaded = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    requestIds.push((body as { requestId: string }).requestId);
    return successfulHarnessResponse(requestIds.at(-1)!, { cached: true });
  }, retryStorage);
  await reloaded.ui.loadCustomProviders();
  assert.equal(reloaded.testButton.disabled, true);
  reloaded.fireTimers();
  await reloaded.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.equal(retryStorage.size, 0);
});

test("custom provider proxy failure keeps the request receipt because the paid outcome is unknown", async () => {
  const requestIds: string[] = [];
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    requestIds.push((body as { requestId: string }).requestId);
    return posts === 1
      ? { ok: false, data: { error: "core_unreachable", message: "core unavailable" } }
      : successfulHarnessResponse(requestIds.at(-1)!, { cached: true });
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  harness.fireTimers();
  await harness.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.match(harness.testStatus.textContent, /^Recent saved result · no new model charge/);
});

test("custom provider structured server failure keeps the request receipt because the paid outcome is unknown", async () => {
  const requestIds: string[] = [];
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    requestIds.push((body as { requestId: string }).requestId);
    return posts === 1
      ? { ok: false, status: 500, data: { error: "internal_error", message: "internal server error" } }
      : successfulHarnessResponse(requestIds.at(-1)!, { cached: true });
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  harness.fireTimers();
  await harness.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.match(harness.testStatus.textContent, /^Recent saved result · no new model charge/);
});

for (const scenario of [
  { name: "empty success", response: { ok: true, status: 200 } },
  { name: "empty client error", response: { ok: false, status: 409 } },
  { name: "wrong request id", response: successfulHarnessResponse("request-from-another-test") },
  {
    name: "unrecognized client error",
    response: { ok: false, status: 409, data: { error: "future_guard_state", message: "unknown state" } },
  },
] satisfies Array<{ name: string; response: ApiResponse }>) {
  test(`custom provider ${scenario.name} keeps the same paid request receipt`, async () => {
    const requestIds: string[] = [];
    let posts = 0;
    const harness = createCustomProviderUi(async (method, _path, body) => {
      if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
      posts += 1;
      requestIds.push((body as { requestId: string }).requestId);
      return posts === 1 ? scenario.response : successfulHarnessResponse(requestIds.at(-1)!, { cached: true });
    });

    await harness.ui.loadCustomProviders();
    await harness.ui.runTest();
    assert.equal(harness.testButton.disabled, true);
    assert.equal(harness.retryStorage.size, 1);
    harness.fireTimers();
    await harness.ui.runTest();
    assert.equal(requestIds[0], requestIds[1]);
    assert.match(harness.testStatus.textContent, /^Recent saved result · no new model charge/);
  });
}

test("custom provider non-streamed success keeps the same paid request receipt", async () => {
  const requestIds: string[] = [];
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    requestIds.push((body as { requestId: string }).requestId);
    return posts === 1
      ? successfulHarnessResponse(requestIds.at(-1)!, { streamed: false })
      : successfulHarnessResponse(requestIds.at(-1)!, { cached: true });
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.retryStorage.size, 1);
  harness.fireTimers();
  await harness.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.match(harness.testStatus.textContent, /^Recent saved result · no new model charge/);
});

test("custom provider over-cap success keeps the same paid request receipt", async () => {
  const requestIds: string[] = [];
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    requestIds.push((body as { requestId: string }).requestId);
    return posts === 1
      ? successfulHarnessResponse(requestIds.at(-1)!, {
          maxOutputTokens: 64,
          usage: {
            inputTokens: 5,
            outputTokens: 65,
            totalTokens: 70,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        })
      : successfulHarnessResponse(requestIds.at(-1)!, { cached: true });
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.retryStorage.size, 1);
  harness.fireTimers();
  await harness.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.match(harness.testStatus.textContent, /^Recent saved result · no new model charge/);
});

test("custom provider accepts and displays a lower safe model output cap", async () => {
  const harness = createCustomProviderUi(async (method, _path, body) =>
    method === "GET"
      ? { ok: true, data: { providers: [customProvider(1)] } }
      : successfulHarnessResponse((body as { requestId: string }).requestId, { maxOutputTokens: 64 }),
  );

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.equal(harness.retryStorage.size, 0);
  assert.equal(harness.testButton.disabled, false);
  assert.match(harness.testStatus.textContent, /output cap 64 · generation verified$/);
});

test("custom provider signed-out response clears the unspent request receipt", async () => {
  const requestIds: string[] = [];
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    requestIds.push((body as { requestId: string }).requestId);
    return { ok: false, status: 401, data: { error: "signed_out" } };
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.equal(harness.retryStorage.size, 0);
  assert.equal(harness.testButton.disabled, false);
  assert.equal(harness.testStatus.textContent, "You are signed out. No model request was sent.");
  await harness.ui.runTest();
  assert.notEqual(requestIds[0], requestIds[1]);
});

test("custom provider ambiguous result persistence blocks a second paid request", async () => {
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    assert.equal(typeof (body as { requestId: string }).requestId, "string");
    return {
      ok: false,
      data: {
        error: "harness_test_result_not_durable",
        message: "retry safely",
        retryAfterMs: 300_000,
        requestExpiresInMs: 300_000,
      },
    };
  });

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  await harness.ui.runTest();
  assert.equal(posts, 1);
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.retryStorage.size, 1);
});

test("custom provider retry window disables only the blocked paid-test target", async () => {
  let posts = 0;
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1, ["luna", "terra"])] } };
    posts += 1;
    return posts === 1
      ? {
          ok: false,
          data: {
            error: "harness_test_in_progress",
            message: "the same paid test is already running",
            retryAfterMs: 30_000,
            requestExpiresInMs: 300_000,
            replayExpected: true,
          },
        }
      : successfulHarnessResponse((body as { requestId: string }).requestId);
  });
  await harness.ui.loadCustomProviders();

  await harness.ui.runTest();
  assert.equal(harness.testButton.disabled, true);
  assert.equal(harness.modelSelect.disabled, false);
  assert.equal(harness.harnessSelect.disabled, false);
  assert.match(harness.testStatus.textContent, /Retry the same saved request after/);
  await harness.ui.runTest();
  assert.equal(posts, 1);

  harness.modelSelect.value = "1";
  harness.modelSelect.onchange?.();
  assert.equal(harness.testButton.disabled, false);
  harness.modelSelect.value = "0";
  harness.modelSelect.onchange?.();
  assert.equal(harness.testButton.disabled, true);

  harness.fireTimers();
  assert.equal(harness.testButton.disabled, false);
  assert.equal(harness.testStatus.textContent, "");
  await harness.ui.runTest();
  assert.equal(posts, 2);
});

test("a near-expiry waiter keeps one request id across reload until the server safety window ends", async () => {
  const retryStorage = new Map<string, string>();
  const requestIds: string[] = [];
  const first = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    requestIds.push((body as { requestId: string }).requestId);
    return {
      ok: false,
      data: {
        error: "harness_test_in_progress",
        message: "running",
        retryAfterMs: 1_000,
        requestExpiresInMs: 5_000,
        replayExpected: true,
      },
    };
  }, retryStorage);
  await first.ui.loadCustomProviders();
  await first.ui.runTest();

  let posts = 0;
  const reloaded = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
    posts += 1;
    requestIds.push((body as { requestId: string }).requestId);
    return posts === 1
      ? {
          ok: false,
          data: {
            error: "harness_test_result_unresolved",
            message: "wait for the safety window",
            retryAfterMs: 4_000,
            requestExpiresInMs: 4_000,
          },
        }
      : successfulHarnessResponse(requestIds.at(-1)!);
  }, retryStorage);
  await reloaded.ui.loadCustomProviders();
  assert.equal(reloaded.testButton.disabled, true);
  reloaded.fireTimers();
  await reloaded.ui.runTest();
  assert.equal(requestIds[0], requestIds[1]);
  assert.equal(reloaded.testButton.disabled, true);

  reloaded.fireTimers();
  assert.equal(reloaded.retryStorage.size, 0);
  assert.equal(reloaded.testButton.disabled, false);
  await reloaded.ui.runTest();
  assert.notEqual(requestIds[1], requestIds[2]);
});

test("custom provider paid tests fail closed when request receipt storage cannot be written", async () => {
  let posts = 0;
  const harness = createCustomProviderUi(
    async (method) => {
      if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
      posts += 1;
      return { ok: true, data: {} };
    },
    new Map(),
    { set: true },
  );
  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();

  assert.equal(posts, 0);
  assert.equal(harness.testButton.disabled, true);
  assert.match(harness.testStatus.textContent, /No model request was sent/);
});

test("custom provider paid tests consume an injected revision-bound receipt", async () => {
  const retryStorage = new Map([
    [
      "qm-custom-provider-test-retry:org%3Aacme:gateway:luna:pi",
      JSON.stringify({
        identity: JSON.stringify(["gateway", "luna", "pi", "openai-responses", 7]),
        requestId: "qa-pre-reserved",
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        retryAt: Date.now(),
      }),
    ],
  ]);
  const requestIds: string[] = [];
  const harness = createCustomProviderUi(async (method, _path, body) => {
    if (method === "GET") return { ok: true, data: { providers: [customProvider(7)] } };
    requestIds.push((body as { requestId: string }).requestId);
    return successfulHarnessResponse(requestIds.at(-1)!, { providerRevision: 7 });
  }, retryStorage);

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.deepEqual(requestIds, ["qa-pre-reserved"]);
});

test("custom provider paid tests stay disabled after reload when request receipt storage cannot be read", async () => {
  let posts = 0;
  const storageFailure = { get: true };
  const harness = createCustomProviderUi(
    async (method) => {
      if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
      posts += 1;
      return { ok: true, data: {} };
    },
    new Map(),
    storageFailure,
  );
  await harness.ui.loadCustomProviders();
  assert.equal(harness.testButton.disabled, true);
  assert.match(harness.testStatus.textContent, /cannot safely store request receipts/);
  await harness.ui.runTest();

  assert.equal(posts, 0);
  assert.equal(harness.testButton.disabled, true);
  assert.match(harness.testStatus.textContent, /cannot safely store request receipts/);

  storageFailure.get = false;
  await harness.ui.loadCustomProviders();
  assert.equal(harness.testButton.disabled, false);
  assert.equal(harness.testStatus.textContent, "");
});

test("custom provider known result fails closed until its stored receipt is verifiably removed", async () => {
  const requestIds: string[] = [];
  const storageFailure = { remove: false };
  const harness = createCustomProviderUi(
    async (method, _path, body) => {
      if (method === "GET") return { ok: true, data: { providers: [customProvider(1)] } };
      requestIds.push((body as { requestId: string }).requestId);
      return successfulHarnessResponse(requestIds.at(-1)!, { providerRevision: 7 });
    },
    new Map(),
    storageFailure,
  );

  await harness.ui.loadCustomProviders();
  storageFailure.remove = true;
  await harness.ui.runTest();
  assert.equal(requestIds.length, 1);
  assert.equal(harness.testButton.disabled, true);
  assert.match(harness.testStatus.textContent, /Receipt cleanup could not be verified/);
  assert.match([...harness.retryStorage.values()].join(""), /"knownResult":true/);
  await harness.ui.runTest();
  assert.equal(requestIds.length, 1);

  storageFailure.remove = false;
  await harness.ui.loadCustomProviders();
  assert.equal(harness.retryStorage.size, 0);
  assert.equal(harness.testButton.disabled, false);
  assert.equal(harness.testStatus.textContent, "");
  await harness.ui.runTest();
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
});

test("custom provider failure displays the saved revision and test time", async () => {
  const harness = createCustomProviderUi(async (method, _path, body) =>
    method === "GET"
      ? { ok: true, data: { providers: [customProvider(1)] } }
      : {
          ok: false,
          status: 502,
          data: {
            error: "provider_test_failed",
            message: "pi could not complete the saved model request",
            requestId: (body as { requestId: string }).requestId,
            providerRevision: 7,
            testedAt: Date.UTC(2026, 7, 24),
          },
        },
  );

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.match(harness.testStatus.textContent, /saved revision 7/);
  assert.match(harness.testStatus.textContent, /tested/);
  assert.match(harness.testStatus.textContent, /pi could not complete/);
});

test("custom provider test success clears when its configuration or selection changes", async () => {
  let providers = [customProvider(1, ["luna", "terra"])];
  const harness = createCustomProviderUi(async (method, _path, body) =>
    method === "GET"
      ? { ok: true, data: { providers } }
      : successfulHarnessResponse((body as { requestId: string }).requestId),
  );

  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.notEqual(harness.testStatus.textContent, "");
  harness.harnessSelect.value = "opencode";
  harness.harnessSelect.onchange?.();
  assert.equal(harness.testStatus.textContent, "");

  harness.harnessSelect.value = "pi";
  await harness.ui.runTest();
  harness.modelSelect.value = "1";
  harness.modelSelect.onchange?.();
  assert.equal(harness.testStatus.textContent, "");

  harness.modelSelect.value = "0";
  await harness.ui.runTest();
  providers = [customProvider(2, ["luna", "terra"])];
  await harness.ui.loadCustomProviders();
  assert.equal(harness.testStatus.textContent, "");
});

test("custom provider test success attributes the server-confirmed upstream model", () => {
  const rendered = renderCustomProviderTestResult(
    {
      harness: "codex",
      modelId: "luna",
      upstreamModelId: "wire-new",
      latencyMs: 42,
      ...TEST_MODEL_EVIDENCE,
      requestedModel: "wire-new",
      responseModel: "wire-new",
      reply: "ready",
    },
    { modelId: "luna", upstreamModelId: "wire-old", providerName: "Gateway" },
  );
  assert.equal(
    rendered,
    "Gateway endpoint · codex · luna · requested wire-new · response wire-new\nFirst token 12 ms · provider 40 ms · total 42 ms · stream verified · custom endpoint verified\nUsage 5 input / 3 output / 8 total · cache read 0 / cache write 0 · output cap 128 · generation verified",
  );
  assert.doesNotMatch(rendered, /wire-old/);
});

test("custom provider test labels a replay as not newly charged", () => {
  const rendered = renderCustomProviderTestResult(
    {
      cached: true,
      harness: "pi",
      modelId: "luna",
      upstreamModelId: "gpt-5.6-luna",
      latencyMs: 42,
      ...TEST_MODEL_EVIDENCE,
      reply: "ready",
    },
    { modelId: "luna", providerName: "Gateway" },
  );
  assert.match(rendered, /^Recent saved result · no new model charge · Gateway endpoint · pi/);
});

test("custom provider test binds its visible result to a saved revision and time", () => {
  const rendered = renderCustomProviderTestResult(
    {
      harness: "codex",
      modelId: "luna",
      providerRevision: 7,
      testedAt: Date.UTC(2026, 7, 24, 8, 0, 0),
      latencyMs: 42,
      upstreamModelId: "gpt-5.6-luna",
      ...TEST_MODEL_EVIDENCE,
      reply: "ready",
    },
    { modelId: "luna", providerName: "Gateway" },
  );
  assert.match(rendered, /^saved revision 7 · tested .+ · Gateway endpoint · codex · luna/);
});

test("custom provider test labels a replayed failure as not newly charged", async () => {
  const harness = createCustomProviderUi(async (method, _path, body) =>
    method === "GET"
      ? { ok: true, data: { providers: [customProvider(1)] } }
      : {
          ok: false,
          status: 502,
          data: {
            cached: true,
            error: "provider_test_failed",
            message: "the prior request failed",
            requestId: (body as { requestId: string }).requestId,
            providerRevision: 1,
            testedAt: Date.UTC(2026, 7, 24),
          },
        },
  );
  await harness.ui.loadCustomProviders();
  await harness.ui.runTest();
  assert.match(
    harness.testStatus.textContent,
    /^Recent saved result · no new model charge · saved revision 1 · tested .+ · the prior request failed$/,
  );
});
