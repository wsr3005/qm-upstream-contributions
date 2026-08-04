import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ProcessCleanup = () => void | Promise<void>;

export interface TrackedChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const cleanups = new Set<ProcessCleanup>();
const signals = ["SIGINT", "SIGTERM"] as const;
const handlers = new Map<NodeJS.Signals, () => void>(signals.map((signal) => [signal, () => terminate(signal)]));
let terminating: Promise<void> | undefined;

function removeHandlers(): void {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}

async function terminateCleanups(signal: NodeJS.Signals): Promise<void> {
  const pending = [...cleanups].reverse();
  cleanups.clear();
  removeHandlers();
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch {
      void 0;
    }
  }
  process.kill(process.pid, signal);
}

function terminate(signal: NodeJS.Signals): void {
  terminating ??= terminateCleanups(signal);
}

export function registerProcessCleanup(cleanup: ProcessCleanup): () => void {
  if (cleanups.size === 0) {
    for (const [signal, handler] of handlers) process.on(signal, handler);
  }
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    if (cleanups.size === 0) removeHandlers();
  };
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroup(pid: number, timeout?: number): Promise<boolean> {
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;
  while (processGroupAlive(pid)) {
    if (deadline !== undefined && Date.now() >= deadline) return false;
    await wait(25);
  }
  return true;
}

async function terminateChildProcessTree(child: ChildProcess, exited: Promise<void>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    await exited;
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited;
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    await exited;
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    void 0;
  }
  if (!(await waitForProcessGroup(pid, 5000))) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      void 0;
    }
    await waitForProcessGroup(pid);
  }
  await exited;
}

export function runTrackedChild(command: string, args: string[], options: SpawnOptions): Promise<TrackedChildResult> {
  const child = spawn(command, args, {
    ...options,
    ...(process.platform === "win32" ? {} : { detached: true }),
  });
  let childError: Error | undefined;
  let childResult: TrackedChildResult | undefined;
  let cleanupRunning = false;
  let settled = false;
  let resolveResult: (result: TrackedChildResult) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<TrackedChildResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let resolveExited: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const settle = (): void => {
    if (cleanupRunning || settled || (!childError && !childResult)) return;
    settled = true;
    unregister();
    if (childError) rejectResult(childError);
    else resolveResult(childResult!);
  };
  child.once("error", (error) => {
    childError = error;
    resolveExited();
    settle();
  });
  child.once("exit", (code, signal) => {
    childResult = { code, signal };
    resolveExited();
    settle();
  });
  const unregister = registerProcessCleanup(async () => {
    cleanupRunning = true;
    await terminateChildProcessTree(child, exited);
    cleanupRunning = false;
    settle();
  });
  return result;
}
