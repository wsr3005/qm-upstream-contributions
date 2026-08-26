import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
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

function onboardingProviderStatus(
  provider: string,
  builtIn: object[],
  custom: object[],
  ready = true,
): { provider: string; configured: boolean; source: string } | undefined {
  const src = slice("function onboardingStatusForProvider(", "function renderOnboardingProviderOptions");
  const context = vm.createContext({
    provider,
    onboardingModelStatuses: builtIn,
    onboardingCustomProviderStatuses: custom,
    onboardingCustomProvidersReady: ready,
  });
  const status = vm.runInContext(`${src}\nonboardingStatusForProvider(provider);`, context);
  return status ? JSON.parse(JSON.stringify(status)) : undefined;
}

function onboardingModelProvider(modelId: string, models: object, custom: object[]): string {
  const src = slice("function onboardingProviderForModel(", "function onboardingStatusForProvider");
  const context = vm.createContext({ modelId, onboardingModels: models, onboardingCustomProviderStatuses: custom });
  return vm.runInContext(`${src}\nonboardingProviderForModel(modelId);`, context);
}

type ApiResponse = { ok: boolean; status?: number; data?: Record<string, unknown> };
type ApiHandler = (method: string, path: string, body?: unknown) => Promise<ApiResponse>;
type OnboardingOutcome = { committed: boolean; customProvidersLoaded: boolean };

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

function formalBrowserReceipt(providerRevision = 1) {
  const createdAt = Date.now();
  const candidateCommit = "a".repeat(40);
  const runAlias = "base-v37";
  const budgetRequestId = "admin-pi";
  const requestId = `qa-${createHash("sha256")
    .update(`browser:${candidateCommit}:${runAlias}:${budgetRequestId}`)
    .digest("hex")}`;
  const storageKey = ["qm-custom-provider-test-retry", "org:acme", "gateway", "gateway/gpt-5.6-luna", "pi"]
    .map(encodeURIComponent)
    .join(":");
  return {
    schemaVersion: "qm-model-test-browser-receipt-v3",
    candidateCommit,
    runAlias,
    budgetRequestId,
    requestId,
    orgScope: "org:acme",
    providerId: "gateway",
    harness: "pi",
    protocol: "openai-responses",
    providerRevision,
    selectionModelId: "gateway/gpt-5.6-luna",
    upstreamModelId: "gpt-5.6-luna",
    createdAt,
    expiresAt: createdAt + 300_000,
    storageKey,
    signature: "b".repeat(64),
  };
}

let nextFakeRequestId = 0;

function createCustomProviderUi(
  initialApi: ApiHandler,
  retryStorage = new Map<string, string>(),
  storageFailure: { get?: boolean; remove?: boolean; set?: boolean } = {},
  reloadOnboarding: (customProviderSnapshot?: unknown) => Promise<OnboardingOutcome> = async () => ({
    committed: true,
    customProvidersLoaded: true,
  }),
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
  element("custom-provider-test-receipt", "textarea").disabled = true;
  element("custom-provider-test-receipt-import", "button").disabled = true;
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
    crypto: { randomUUID: () => `request-${++nextFakeRequestId}`, subtle: webcrypto.subtle },
    TextEncoder,
    Uint8Array,
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
    loadOnboarding: reloadOnboarding,
    renderOnboardingModelUnavailable: () => {
      element("onboarding-model-badge").textContent = "Unknown";
      element("onboarding-model-summary").textContent = "Model readiness could not be confirmed. Try again.";
    },
    setOnboardingModelStatus: (_owner: string, message: string, kind: string, sticky = false) => {
      const target = element("st-onboarding-model");
      target.textContent = message;
      target.className = "status " + (kind || "");
      statuses.push({ id: "st-onboarding-model", message, kind, sticky });
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
    loadCustomProviders(): Promise<
      false | { status: "loaded" | "superseded"; generation: number; providers: object[] }
    >;
    runTest(): Promise<void>;
    saveProvider(): Promise<void>;
  };
  return {
    ui,
    modelSelect,
    harnessSelect,
    testButton: element("custom-provider-test"),
    receiptInput: element("custom-provider-test-receipt"),
    receiptImport: element("custom-provider-test-receipt-import"),
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
    onboardingBadge: element("onboarding-model-badge"),
    onboardingSummary: element("onboarding-model-summary"),
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
  const source = slice("async function loadOnboarding(", '$("onboarding-model-provider").onchange');
  const context = vm.createContext({
    api: apiHandler,
    encodeURIComponent,
    loadCustomProviders: async () => {
      customProviderLoads += 1;
      return { generation: 0, providers: [] };
    },
    customProvidersLoad: 0,
    onboardingLoad: 0,
    orgScope: () => "org:acme",
    renderOnboardingModelUnavailable: () => undefined,
    renderOnboardingProviderOptions: () => undefined,
    setOnboardingModelStatus: () => undefined,
    clearOnboardingLoaderStatus: () => undefined,
    setStatus: () => undefined,
  });
  await (vm.runInContext(`${source}\nloadOnboarding();`, context) as Promise<void>);
  return customProviderLoads;
}

async function onboardingLatestLoadWins(customProviderSnapshot: object | null = null): Promise<{
  summary: string;
  customProviderLoads: number;
}> {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id)!;
  };
  const pending = [0, 1].map(() => new Map<string, (value: ApiResponse) => void>());
  let wave = -1;
  let customProviderLoads = 0;
  const api = (_method: string, path: string) => {
    if (path === "/api/model-providers") wave += 1;
    const current = wave;
    return new Promise<ApiResponse>((resolve) => pending[current]!.set(path, resolve));
  };
  const source = slice("async function loadOnboarding(", '$("onboarding-model-provider").onchange');
  const context = vm.createContext({
    $: element,
    api,
    encodeURIComponent,
    loadCustomProviders: async () => {
      customProviderLoads += 1;
      return { generation: 0, providers: [] };
    },
    customProvidersLoad: 0,
    orgScope: () => "org:acme",
    onboardingLoad: 0,
    onboardingModelStatuses: [],
    onboardingModels: {},
    onboardingProviderForModel: () => "openai",
    onboardingStatusForProvider: () => ({ configured: true, source: "admin" }),
    onboardingBadge: () => undefined,
    renderOnboardingProviderOptions: () => undefined,
    renderOnboardingModelOptions: () => undefined,
    setOnboardingModelStatus: () => undefined,
    clearOnboardingLoaderStatus: () => undefined,
    setStatus: () => undefined,
    connectorName: (provider: string) => provider,
    MODEL_PROVIDER_LABELS: { openai: "OpenAI" },
    viewLoadedAt: {},
  });
  const loadOnboarding = vm.runInContext(`${source}\nloadOnboarding;`, context) as (
    customProviderSnapshot?: object | null,
  ) => Promise<void>;
  const first = loadOnboarding(customProviderSnapshot);
  const second = loadOnboarding(customProviderSnapshot);
  const resolveWave = (index: number, baseModel: string) => {
    pending[index]!.get("/api/model-providers")!({ ok: true, data: { providers: [], models: [] } });
    pending[index]!.get("/api/slack-installation")!({ ok: true, data: { configured: false } });
    pending[index]!.get("/api/connector-catalog")!({ ok: true, data: { catalog: [] } });
    pending[index]!.get("/api/scopes/org%3Aacme")!({ ok: true, data: { baseModel } });
  };
  resolveWave(1, "new-model");
  await second;
  resolveWave(0, "old-model");
  await first;
  return { summary: element("onboarding-model-summary").textContent, customProviderLoads };
}

async function onboardingReplacesStaleCustomProviderSnapshot(): Promise<{
  summary: string;
  customProviderLoads: number;
}> {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id)!;
  };
  let customProviderLoads = 0;
  const source = slice("async function loadOnboarding(", '$("onboarding-model-provider").onchange');
  const context = vm.createContext({
    $: element,
    api: async (_method: string, path: string): Promise<ApiResponse> => {
      if (path === "/api/model-providers") return { ok: true, data: { providers: [], models: [] } };
      if (path === "/api/slack-installation") return { ok: true, data: { configured: false } };
      if (path === "/api/connector-catalog") return { ok: true, data: { catalog: [] } };
      return { ok: true, data: { baseModel: "luna" } };
    },
    encodeURIComponent,
    loadCustomProviders: async () => {
      customProviderLoads += 1;
      if (customProviderLoads === 1) {
        context.customProvidersLoad += 2;
        return false;
      }
      context.customProvidersLoad += 1;
      return Object.freeze({
        generation: context.customProvidersLoad,
        providers: Object.freeze([{ ...customProvider(2), published: true, disabled: true }]),
      });
    },
    orgScope: () => "org:acme",
    onboardingLoad: 0,
    onboardingModelStatuses: [],
    onboardingModels: {},
    onboardingProviderForModel: (_modelId: string, statuses: Array<Record<string, unknown>>) => statuses[0]?.id || "",
    onboardingStatusForProvider: (provider: string, statuses: Array<Record<string, unknown>>, ready: boolean) => {
      const status = statuses.find((item) => item.id === provider);
      return status
        ? {
            configured: Boolean(ready && status.hasKey && status.published && !status.disabled),
            source: "admin",
          }
        : undefined;
    },
    onboardingBadge: () => undefined,
    renderOnboardingProviderOptions: () => undefined,
    renderOnboardingModelOptions: () => undefined,
    setOnboardingModelStatus: () => undefined,
    clearOnboardingLoaderStatus: () => undefined,
    setStatus: () => undefined,
    connectorName: (provider: string) => provider,
    MODEL_PROVIDER_LABELS: {},
    viewLoadedAt: {},
    customProvidersLoad: 2,
  });
  const loadOnboarding = vm.runInContext(`${source}\nloadOnboarding;`, context) as (
    customProviderSnapshot: object,
  ) => Promise<void>;
  const staleReadySnapshot = Object.freeze({
    generation: 1,
    providers: Object.freeze([{ ...customProvider(1), published: true, disabled: false }]),
  });
  await loadOnboarding(staleReadySnapshot);
  return { summary: element("onboarding-model-summary").textContent, customProviderLoads };
}

async function onboardingSetupFailureClearsReady(
  throws: boolean,
  staleCustomProviderSnapshot = false,
): Promise<{
  badge: string;
  summary: string;
  outcome: OnboardingOutcome;
}> {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id)!;
  };
  element("onboarding-model-badge").textContent = "Ready";
  element("onboarding-model-summary").textContent = "luna · admin-managed key";
  const unavailableSource = slice(
    "function renderOnboardingModelUnavailable() {",
    "function onboardingProviderForModel",
  );
  const onboardingSource = slice("async function loadOnboarding(", '$("onboarding-model-provider").onchange');
  const context = vm.createContext({
    $: element,
    api: async (_method: string, path: string): Promise<ApiResponse> => {
      if (path === "/api/slack-installation") {
        if (throws) throw new Error("offline");
        return { ok: false, data: {} };
      }
      return { ok: true, data: {} };
    },
    encodeURIComponent,
    loadCustomProviders: async () => {
      context.customProvidersLoad += 1;
      return false;
    },
    orgScope: () => "org:acme",
    onboardingLoad: 0,
    onboardingModelStatuses: [{ provider: "openai", configured: true }],
    onboardingModels: { openai: [{ id: "luna" }] },
    onboardingBadge: (id: string, text: string) => {
      element(id).textContent = text;
    },
    renderOnboardingProviderOptions: () => undefined,
    setOnboardingModelStatus: () => undefined,
    clearOnboardingLoaderStatus: () => undefined,
    setStatus: () => undefined,
    customProvidersLoad: staleCustomProviderSnapshot ? 2 : 1,
  });
  const loadOnboarding = vm.runInContext(`${unavailableSource}\n${onboardingSource}\nloadOnboarding;`, context) as (
    customProviderSnapshot: object,
  ) => Promise<OnboardingOutcome>;
  const outcome = await loadOnboarding({ generation: 1, providers: [] });
  return {
    badge: element("onboarding-model-badge").textContent,
    summary: element("onboarding-model-summary").textContent,
    outcome: JSON.parse(JSON.stringify(outcome)),
  };
}

async function onboardingLoaderErrorClearsAfterRecovery(): Promise<{
  badge: string;
  status: string;
  concurrentActionStatus: string;
}> {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id)!;
  };
  let fails = true;
  let statusOwner: string | null = null;
  const unavailableSource = slice(
    "function renderOnboardingModelUnavailable() {",
    "function onboardingProviderForModel",
  );
  const onboardingSource = slice("async function loadOnboarding(", '$("onboarding-model-provider").onchange');
  const context = vm.createContext({
    $: element,
    api: async (_method: string, path: string): Promise<ApiResponse> => {
      if (fails && path === "/api/slack-installation") return { ok: false, data: {} };
      if (path === "/api/model-providers") return { ok: true, data: { providers: [], models: [] } };
      if (path === "/api/slack-installation") return { ok: true, data: { configured: false } };
      if (path === "/api/connector-catalog") return { ok: true, data: { catalog: [] } };
      return { ok: true, data: { baseModel: "luna" } };
    },
    encodeURIComponent,
    loadCustomProviders: async () => ({ generation: 1, providers: [] }),
    orgScope: () => "org:acme",
    onboardingLoad: 0,
    onboardingModelStatuses: [],
    onboardingModels: {},
    onboardingProviderForModel: () => "gateway",
    onboardingStatusForProvider: () => ({ configured: true, source: "admin" }),
    onboardingBadge: (id: string, text: string) => {
      element(id).textContent = text;
    },
    renderOnboardingProviderOptions: () => undefined,
    renderOnboardingModelOptions: () => undefined,
    setOnboardingModelStatus: (owner: string, message: string) => {
      statusOwner = owner;
      element("st-onboarding-model").textContent = message;
    },
    clearOnboardingLoaderStatus: () => {
      if (statusOwner !== "loader") return;
      statusOwner = null;
      element("st-onboarding-model").textContent = "";
    },
    setStatus: (id: string, message: string) => {
      element(id).textContent = message;
    },
    connectorName: (provider: string) => provider,
    MODEL_PROVIDER_LABELS: {},
    viewLoadedAt: {},
    customProvidersLoad: 1,
  });
  const loadOnboarding = vm.runInContext(`${unavailableSource}\n${onboardingSource}\nloadOnboarding;`, context) as (
    customProviderSnapshot: object,
  ) => Promise<OnboardingOutcome>;
  await loadOnboarding({ generation: 1, providers: [] });
  assert.equal(element("st-onboarding-model").textContent, "Setup status could not be loaded. Try again.");
  fails = false;
  await loadOnboarding({ generation: 1, providers: [] });
  const status = element("st-onboarding-model").textContent;
  context.setOnboardingModelStatus("action", "Validating with gateway…");
  await loadOnboarding({ generation: 1, providers: [] });
  return {
    badge: element("onboarding-model-badge").textContent,
    status,
    concurrentActionStatus: element("st-onboarding-model").textContent,
  };
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

test("onboarding treats a keyed custom base model provider as ready", () => {
  assert.deepEqual(
    onboardingProviderStatus(
      "enterprise-responses",
      [],
      [{ id: "enterprise-responses", hasKey: true, published: true, disabled: false, testable: true }],
    ),
    { provider: "enterprise-responses", configured: true, source: "admin" },
  );
});

test("onboarding keeps a keyless custom base model provider not ready", () => {
  assert.deepEqual(
    onboardingProviderStatus(
      "enterprise-responses",
      [],
      [{ id: "enterprise-responses", hasKey: false, published: true, disabled: false, testable: true }],
    ),
    { provider: "enterprise-responses", configured: false, source: "admin" },
  );
});

test("onboarding preserves built-in provider credential status", () => {
  const builtIn = { provider: "openai", configured: true, source: "environment" };
  assert.deepEqual(onboardingProviderStatus("openai", [builtIn], [{ id: "openai", hasKey: false }]), builtIn);
});

test("onboarding keeps staged and disabled custom providers not ready", () => {
  const staged = { id: "enterprise-responses", hasKey: true, published: false, disabled: false, testable: true };
  const disabled = { id: "enterprise-responses", hasKey: true, published: true, disabled: true, testable: true };
  assert.equal(onboardingProviderStatus("enterprise-responses", [], [staged])?.configured, false);
  assert.equal(onboardingProviderStatus("enterprise-responses", [], [disabled])?.configured, false);
});

test("onboarding fails closed when custom provider status loading fails", () => {
  const stale = { id: "enterprise-responses", hasKey: true, published: true, disabled: false, testable: true };
  assert.equal(onboardingProviderStatus("enterprise-responses", [], [stale], false)?.configured, false);
});

test("onboarding resolves a saved custom model owner outside the selectable catalog", () => {
  assert.equal(
    onboardingModelProvider("enterprise-responses/gpt-5.6-luna", {}, [
      { id: "enterprise-responses", models: [{ id: "enterprise-responses/gpt-5.6-luna" }] },
    ]),
    "enterprise-responses",
  );
});

test("onboarding does not attribute an unknown base model to a configured built-in provider", () => {
  assert.equal(onboardingModelProvider("enterprise-responses/gpt-5.6-luna", {}, []), "");
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
  assert.match(html, /id="custom-provider-test-receipt"/);
  assert.match(html, /id="custom-provider-test-receipt-import" disabled>Import receipt/);
  assert.match(html, /Importing does not call the model/);
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

test("a formal browser receipt imports only after exact target and storage verification", async () => {
  const retryStorage = new Map<string, string>();
  const provider = {
    ...customProvider(1),
    models: [{ id: "gateway/gpt-5.6-luna", upstreamId: "gpt-5.6-luna" }],
  };
  let validatedReservation: unknown;
  let testReservation: unknown;
  const harness = createCustomProviderUi(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/harness-test-reservation")) {
      validatedReservation = (body as { reservation: unknown }).reservation;
      return { ok: true, data: { ok: true } };
    }
    if (method === "POST" && path.endsWith("/harness-test")) {
      testReservation = (body as { reservation: unknown }).reservation;
      return successfulHarnessResponse((body as { requestId: string }).requestId);
    }
    return { ok: true, data: { providers: [provider] } };
  }, retryStorage);
  await harness.ui.loadCustomProviders();
  const receipt = formalBrowserReceipt();
  harness.receiptInput.value = JSON.stringify(receipt);

  await harness.receiptImport.onclick?.();

  assert.equal(harness.receiptInput.value, "");
  assert.equal(harness.modelSelect.value, "0");
  assert.equal(harness.harnessSelect.value, "pi");
  assert.deepEqual(JSON.parse(JSON.stringify(validatedReservation)), receipt);
  assert.equal(JSON.parse(retryStorage.get(receipt.storageKey) || "null").requestId, receipt.requestId);
  assert.deepEqual(JSON.parse(retryStorage.get(receipt.storageKey) || "null").formalReservation, receipt);
  assert.match(harness.testStatus.textContent, /Formal pi receipt imported/);
  assert.equal(harness.testButton.disabled, false);
  await harness.ui.runTest();
  assert.deepEqual(JSON.parse(JSON.stringify(testReservation)), receipt);
});

test("a formal browser receipt rejected by Core is not stored or made runnable", async () => {
  const retryStorage = new Map<string, string>();
  const provider = {
    ...customProvider(1),
    models: [{ id: "gateway/gpt-5.6-luna", upstreamId: "gpt-5.6-luna" }],
  };
  const harness = createCustomProviderUi(
    async (method) =>
      method === "POST"
        ? { ok: false, data: { message: "the formal test reservation is invalid" } }
        : { ok: true, data: { providers: [provider] } },
    retryStorage,
  );
  await harness.ui.loadCustomProviders();
  harness.receiptInput.value = JSON.stringify(formalBrowserReceipt());

  await harness.receiptImport.onclick?.();

  assert.equal(retryStorage.size, 0);
  assert.match(harness.testStatus.textContent, /formal test reservation is invalid/);
});

test("a formal browser receipt rejects a mismatched provider revision without storage", async () => {
  const retryStorage = new Map<string, string>();
  const provider = {
    ...customProvider(1),
    models: [{ id: "gateway/gpt-5.6-luna", upstreamId: "gpt-5.6-luna" }],
  };
  const harness = createCustomProviderUi(async () => ({ ok: true, data: { providers: [provider] } }), retryStorage);
  await harness.ui.loadCustomProviders();
  harness.receiptInput.value = JSON.stringify(formalBrowserReceipt(2));

  await harness.receiptImport.onclick?.();

  assert.equal(retryStorage.size, 0);
  assert.match(harness.testStatus.textContent, /does not match the selected Harness target/);
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

test("a stale onboarding request cannot overwrite a newer render", async () => {
  assert.equal((await onboardingLatestLoadWins()).summary, "new-model · admin-managed key");
});

test("a mutation readiness refresh reuses the successful custom provider snapshot", async () => {
  const result = await onboardingLatestLoadWins({ generation: 0, providers: [] });
  assert.equal(result.summary, "new-model · admin-managed key");
  assert.equal(result.customProviderLoads, 0);
});

test("a stale mutation snapshot is replaced before onboarding commits its badge", async () => {
  const result = await onboardingReplacesStaleCustomProviderSnapshot();
  assert.equal(result.customProviderLoads, 2);
  assert.equal(result.summary, "luna cannot run until its gateway key is configured.");
});

test("onboarding clears a previous Ready state when setup throws", async () => {
  const result = await onboardingSetupFailureClearsReady(true);
  assert.equal(result.badge, "Unknown");
  assert.equal(result.summary, "Model readiness could not be confirmed. Try again.");
  assert.deepEqual(result.outcome, { committed: true, customProvidersLoaded: true });
});

test("onboarding clears a previous Ready state when setup returns a failure", async () => {
  const result = await onboardingSetupFailureClearsReady(false);
  assert.equal(result.badge, "Unknown");
  assert.equal(result.summary, "Model readiness could not be confirmed. Try again.");
  assert.deepEqual(result.outcome, { committed: true, customProvidersLoaded: true });
});

test("onboarding setup failure still resolves a stale provider snapshot to its current failure", async () => {
  const result = await onboardingSetupFailureClearsReady(true, true);
  assert.equal(result.badge, "Unknown");
  assert.equal(result.summary, "Model readiness could not be confirmed. Try again.");
  assert.deepEqual(result.outcome, { committed: true, customProvidersLoaded: false });
});

test("onboarding clears its loader error after a current successful recovery", async () => {
  const result = await onboardingLoaderErrorClearsAfterRecovery();
  assert.equal(result.badge, "Ready");
  assert.equal(result.status, "");
  assert.equal(result.concurrentActionStatus, "Validating with gateway…");
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
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.ui.loadCustomProviders())), {
    status: "loaded",
    generation: 2,
    providers: [{ ...customProvider(1), verifiedTargets: [] }],
  });
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
  harness.onboardingBadge.textContent = "Ready";
  harness.onboardingSummary.textContent = "luna · admin-managed key";

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
  assert.equal(
    harness.providerStatus.textContent,
    "Provider saved, but its current status could not be refreshed. Try again.",
  );
  assert.equal(harness.providerStatus.className, "status err");
  assert.equal(harness.onboardingBadge.textContent, "Unknown");
  assert.equal(harness.onboardingSummary.textContent, "Model readiness could not be confirmed. Try again.");
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
  harness.onboardingBadge.textContent = "Ready";
  harness.onboardingSummary.textContent = "luna · admin-managed key";
  const row = harness.providerRows.children[0];
  const actions = row?.children.at(-1);
  const remove = actions?.children.at(-1);
  assert.ok(remove?.onclick);

  await remove.onclick();

  assert.equal(
    harness.providerStatus.textContent,
    "Provider removed, but its current status could not be refreshed. Try again.",
  );
  assert.equal(harness.providerStatus.className, "status err");
  assert.equal(harness.onboardingBadge.textContent, "Unknown");
  assert.equal(harness.onboardingSummary.textContent, "Model readiness could not be confirmed. Try again.");
});

test("a superseded mutation refresh converges instead of replacing newer Ready with Unknown", async () => {
  let listingCalls = 0;
  let resolveMutationRefresh!: (response: ApiResponse) => void;
  let markMutationRefreshStarted!: () => void;
  const mutationRefresh = new Promise<ApiResponse>((resolve) => {
    resolveMutationRefresh = resolve;
  });
  const mutationRefreshStarted = new Promise<void>((resolve) => {
    markMutationRefreshStarted = resolve;
  });
  let onboardingReloads = 0;
  const listing = { ok: true, data: { providers: [customProvider(1)] } };
  const harness = createCustomProviderUi(
    async (method) => {
      if (method === "DELETE") return { ok: true, data: {} };
      listingCalls += 1;
      if (listingCalls === 2) {
        markMutationRefreshStarted();
        return mutationRefresh;
      }
      return listing;
    },
    new Map(),
    {},
    async () => {
      onboardingReloads += 1;
      return { committed: true, customProvidersLoaded: true };
    },
  );
  await harness.ui.loadCustomProviders();
  harness.onboardingBadge.textContent = "Ready";
  harness.onboardingSummary.textContent = "luna · admin-managed key";
  const remove = harness.providerRows.children[0]?.children.at(-1)?.children.at(-1)?.onclick?.();
  await mutationRefreshStarted;
  await harness.ui.loadCustomProviders();
  resolveMutationRefresh(listing);
  await remove;

  assert.equal(onboardingReloads, 1);
  assert.equal(harness.providerStatus.textContent, "Provider removed.");
  assert.equal(harness.onboardingBadge.textContent, "Ready");
  assert.equal(harness.onboardingSummary.textContent, "luna · admin-managed key");
});

test("custom provider publish exposes an immediate refresh failure and clears Ready", async () => {
  let listingCalls = 0;
  const provider = {
    ...customProvider(1),
    published: false,
    verifiedTargets: ["pi", "opencode", "codex"].map((harnessId) => ({
      modelId: "luna",
      harnessId,
      revision: 1,
    })),
  };
  const harness = createCustomProviderUi(async (method) => {
    if (method === "POST") return { ok: true, data: {} };
    listingCalls += 1;
    return listingCalls === 1
      ? { ok: true, data: { providers: [provider] } }
      : { ok: false, data: { message: "refresh failed" } };
  });
  await harness.ui.loadCustomProviders();
  harness.onboardingBadge.textContent = "Ready";
  harness.onboardingSummary.textContent = "luna · admin-managed key";

  await harness.providerRows.children[0]?.children.at(-1)?.children[1]?.onclick?.();

  assert.equal(
    harness.providerStatus.textContent,
    "Provider opened, but its current status could not be refreshed. Try again.",
  );
  assert.equal(harness.providerStatus.className, "status err");
  assert.equal(harness.onboardingBadge.textContent, "Unknown");
  assert.equal(harness.onboardingSummary.textContent, "Model readiness could not be confirmed. Try again.");
});

test("custom provider mutations refresh onboarding readiness immediately", async () => {
  let reloads = 0;
  const preloadGenerations: number[] = [];
  const provider = {
    ...customProvider(1),
    published: false,
    testable: true,
    verifiedTargets: ["pi", "opencode", "codex"].map((harnessId) => ({
      modelId: "luna",
      harnessId,
      revision: 1,
    })),
  };
  const harness = createCustomProviderUi(
    async (method) => (method === "GET" ? { ok: true, data: { providers: [provider] } } : { ok: true, data: {} }),
    new Map(),
    {},
    async (customProviderSnapshot) => {
      reloads += 1;
      preloadGenerations.push((customProviderSnapshot as { generation: number }).generation);
      return { committed: true, customProvidersLoaded: true };
    },
  );
  await harness.ui.loadCustomProviders();
  let actions = harness.providerRows.children[0]?.children.at(-1);
  const publish = actions?.children[1];
  assert.ok(publish?.onclick);
  await publish.onclick();
  assert.equal(harness.providerStatus.textContent, "Verified provider opened to employees.");
  harness.setProviderForm();
  await harness.ui.saveProvider();
  assert.equal(
    harness.providerStatus.textContent,
    "Provider saved as staged. Verify every supported Harness, then open it to employees.",
  );
  actions = harness.providerRows.children[0]?.children.at(-1);
  const remove = actions?.children.at(-1);
  assert.ok(remove?.onclick);
  await remove.onclick();
  assert.equal(harness.providerStatus.textContent, "Provider removed.");
  assert.equal(reloads, 3);
  assert.deepEqual(preloadGenerations, [2, 3, 4]);
});

test("custom provider mutations disclose a failed current-status refresh", async () => {
  const provider = {
    ...customProvider(1),
    published: false,
    testable: true,
    verifiedTargets: ["pi", "opencode", "codex"].map((harnessId) => ({
      modelId: "luna",
      harnessId,
      revision: 1,
    })),
  };
  const harness = createCustomProviderUi(
    async (method) => (method === "GET" ? { ok: true, data: { providers: [provider] } } : { ok: true, data: {} }),
    new Map(),
    {},
    async () => ({ committed: true, customProvidersLoaded: false }),
  );
  await harness.ui.loadCustomProviders();
  let actions = harness.providerRows.children[0]?.children.at(-1);
  await actions?.children[1]?.onclick?.();
  assert.equal(
    harness.providerStatus.textContent,
    "Provider opened, but its current status could not be refreshed. Try again.",
  );
  assert.equal(harness.providerStatus.className, "status err");

  harness.setProviderForm();
  await harness.ui.saveProvider();
  assert.equal(
    harness.providerStatus.textContent,
    "Provider saved, but its current status could not be refreshed. Try again.",
  );
  assert.equal(harness.providerStatus.className, "status err");

  actions = harness.providerRows.children[0]?.children.at(-1);
  await actions?.children.at(-1)?.onclick?.();
  assert.equal(
    harness.providerStatus.textContent,
    "Provider removed, but its current status could not be refreshed. Try again.",
  );
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
