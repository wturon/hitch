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

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ThreadStartResponse {
  thread: { id: string };
}

export interface CodexStartSpec {
  taskKey: string;
  prompt: string;
  cwd: string;
  threadName?: string;
  onThreadStarted?: (threadId: string) => Promise<void>;
}

export interface CodexStartResult {
  status: "focused" | "started";
  threadId: string;
}

export interface CodexDraftSpec {
  prompt: string;
  cwd: string;
  originUrl?: string;
}

const recentStarts = new Map<string, { threadId: string; at: number }>();
const inFlightStarts = new Map<string, Promise<CodexStartResult>>();
const START_GRACE_MS = 45_000;

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initializing: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
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

  private async ensureInitialized(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (!this.child) this.startProcess();

    this.initializing = this.send("initialize", {
      clientInfo: { name: "hitch-daemon", version: "0.1.0" },
      capabilities: {},
    }).then(() => undefined);

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

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        console.log(`[hitch] codex app-server: ${line}`);
        continue;
      }

      if (!("id" in message)) continue; // notification; nothing to resolve
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
}

const server = new CodexAppServer();

export async function startCodexChat(
  spec: CodexStartSpec,
): Promise<CodexStartResult> {
  const recent = recentStarts.get(spec.taskKey);
  if (recent && Date.now() - recent.at < START_GRACE_MS) {
    await openCodexThread(recent.threadId);
    return { status: "focused", threadId: recent.threadId };
  }

  const inFlight = inFlightStarts.get(spec.taskKey);
  if (inFlight) {
    const result = await inFlight;
    await openCodexThread(result.threadId);
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

  await server.request(
    "turn/start",
    {
      threadId,
      cwd: spec.cwd,
      input: [{ type: "text", text: spec.prompt, text_elements: [] }],
    },
    45_000,
  );

  await openCodexThread(threadId);
  return { status: "started", threadId };
}

export async function openCodexThread(threadId: string): Promise<void> {
  if (!threadId || platform() !== "darwin") return;
  await run("/usr/bin/open", [`codex://threads/${encodeURIComponent(threadId)}`], {
    timeout: 5_000,
  });
}

export async function openCodexDraft(spec: CodexDraftSpec): Promise<string> {
  if (platform() !== "darwin") return "unsupported-platform";

  const url = new URL("codex://threads/new");
  url.searchParams.set("prompt", spec.prompt);
  url.searchParams.set("path", spec.cwd);
  if (spec.originUrl) url.searchParams.set("originUrl", spec.originUrl);

  await run("/usr/bin/open", [url.toString()], { timeout: 5_000 });
  return "drafted";
}

export async function closeCodexAppServer(): Promise<void> {
  await server.close();
}
