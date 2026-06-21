import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

const CODEX_CANDIDATES = [
  process.env.CODEX_BIN,
  "/Applications/Codex.app/Contents/Resources/codex",
  "codex",
].filter((p): p is string => Boolean(p));

function codexBin(): string {
  for (const p of CODEX_CANDIDATES) {
    if (p === "codex" || existsSync(p)) return p;
  }
  return "codex";
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ThreadStartResponse {
  thread: { id: string };
}

export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

interface ThreadReadResponse {
  thread: {
    turns?: Array<{
      id: string;
      status: CodexTurnStatus;
      startedAt?: number | null;
      completedAt?: number | null;
    }>;
  };
}

export interface CodexStartSpec {
  taskKey: string;
  prompt: string;
  cwd: string;
  threadName?: string;
  // Kickoff parameters passed on `turn/start` (the app-server's TurnStartParams
  // accepts both): the model id and the reasoning effort (ReasoningEffort).
  model?: string;
  effort?: string;
  onThreadStarted?: (threadId: string) => Promise<void>;
  onTurnCompleted?: (threadId: string) => Promise<void>;
}

export interface CodexStartResult {
  status: "focused" | "started";
  threadId: string;
}

export interface CodexTurnSnapshot {
  id: string;
  status: CodexTurnStatus;
  startedAt?: number | null;
  completedAt?: number | null;
}

const recentStarts = new Map<string, { threadId: string; at: number }>();
const inFlightStarts = new Map<string, Promise<CodexStartResult>>();
const START_GRACE_MS = 45_000;

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initializing: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private turnCompletedHandlers = new Map<string, Set<() => void>>();
  private stdoutBuffer = "";
  private stderrBuffer = "";

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    await this.ensureInitialized();
    return this.send<T>(method, params, timeoutMs);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initializing = null;
    if (!child || child.killed) return;
    child.kill("SIGTERM");
  }

  onTurnCompleted(threadId: string, handler: () => void): () => void {
    let handlers = this.turnCompletedHandlers.get(threadId);
    if (!handlers) {
      handlers = new Set();
      this.turnCompletedHandlers.set(threadId, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.turnCompletedHandlers.delete(threadId);
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (!this.child) this.startProcess();

    this.initializing = this.send("initialize", {
      clientInfo: { name: "hitch-daemon", version: "0.1.0" },
      capabilities: {},
    }).then(() => {
      this.notify("initialized", {});
    });

    try {
      await this.initializing;
    } catch (err) {
      this.initializing = null;
      throw err;
    }
  }

  private startProcess(): void {
    const child = spawn(codexBin(), ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => this.onStderr(chunk));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.initializing = null;
      const err = new Error(
        `codex app-server exited${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
      );
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
        this.pending.delete(id);
      }
    });
  }

  private send<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.child || !this.child.stdin.writable) {
      this.startProcess();
    }
    const child = this.child;
    if (!child) throw new Error("failed to start codex app-server");

    const id = this.nextId++;
    const message =
      params === undefined ? { id, method } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out during ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || !this.child.stdin.writable) return;
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcResponse | JsonRpcNotification;
      try {
        message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
      } catch {
        console.log(`[hitch] codex app-server: ${line}`);
        continue;
      }

      if (!("id" in message)) {
        this.onNotification(message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          new Error(
            `codex app-server ${pending.method} failed: ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) console.log(`[hitch] codex app-server: ${line}`);
    }
  }

  private onNotification(message: JsonRpcNotification): void {
    if (message.method !== "turn/completed") return;
    const params = message.params as { threadId?: unknown } | undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : "";
    if (!threadId) return;

    const handlers = this.turnCompletedHandlers.get(threadId);
    if (!handlers) return;
    for (const handler of handlers) handler();
    this.turnCompletedHandlers.delete(threadId);
  }
}

const server = new CodexAppServer();

export async function startCodexChat(
  spec: CodexStartSpec,
): Promise<CodexStartResult> {
  const recent = recentStarts.get(spec.taskKey);
  if (recent && Date.now() - recent.at < START_GRACE_MS) {
    return { status: "focused", threadId: recent.threadId };
  }

  const inFlight = inFlightStarts.get(spec.taskKey);
  if (inFlight) {
    const result = await inFlight;
    return { status: "focused", threadId: result.threadId };
  }

  const started = doStartCodexChat(spec);
  inFlightStarts.set(spec.taskKey, started);
  try {
    return await started;
  } finally {
    inFlightStarts.delete(spec.taskKey);
  }
}

async function doStartCodexChat(
  spec: CodexStartSpec,
): Promise<CodexStartResult> {
  const started = await server.request<ThreadStartResponse>("thread/start", {
    cwd: spec.cwd,
  });
  const threadId = started.thread.id;
  recentStarts.set(spec.taskKey, { threadId, at: Date.now() });

  if (spec.threadName) {
    await server.request("thread/name/set", {
      threadId,
      name: spec.threadName,
    });
  }

  if (spec.onThreadStarted) await spec.onThreadStarted(threadId);

  let unsubscribeTurnCompleted: (() => void) | undefined;
  if (spec.onTurnCompleted) {
    unsubscribeTurnCompleted = server.onTurnCompleted(threadId, () => {
      unsubscribeTurnCompleted?.();
      void spec.onTurnCompleted?.(threadId).catch((err) => {
        console.log(
          `[hitch] codex app-server: failed to handle turn completion for ${threadId}: ${String(err)}`,
        );
      });
    });
  }

  try {
    const turnParams: Record<string, unknown> = {
      threadId,
      cwd: spec.cwd,
      input: [{ type: "text", text: spec.prompt, text_elements: [] }],
    };
    // Override the model/effort for this turn (and subsequent ones) when set.
    if (spec.model) turnParams.model = spec.model;
    if (spec.effort) turnParams.effort = spec.effort;
    await server.request("turn/start", turnParams, 45_000);
  } catch (err) {
    unsubscribeTurnCompleted?.();
    throw err;
  }

  return { status: "started", threadId };
}

export async function openCodexThread(threadId: string): Promise<void> {
  if (!threadId || platform() !== "darwin") return;
  await run("/usr/bin/open", [`codex://threads/${encodeURIComponent(threadId)}`], {
    timeout: 5_000,
  });
}

export async function latestCodexTurn(
  threadId: string,
): Promise<CodexTurnSnapshot | null> {
  if (!threadId) return null;
  const response = await server.request<ThreadReadResponse>(
    "thread/read",
    { threadId, includeTurns: true },
    10_000,
  );
  const turns = response.thread.turns ?? [];
  return turns.at(-1) ?? null;
}

export async function closeCodexAppServer(): Promise<void> {
  await server.close();
}
