// T3Code integration mechanics (EXPERIMENTAL — stopgap).
//
// T3Code (https://t3.codes) is an *environment*, not a harness: an Electron shell
// whose UI is the web app served from a loopback Node server. It wraps Claude Code
// (provider instance `claudeAgent`) and Codex (`codex`). Hitch drives it entirely
// over a Chrome DevTools Protocol (CDP) **pipe** (inherited fds 3/4) against a
// T3Code process *Hitch itself launched* — the only process that can speak the pipe.
//
// Why everything rides the CDP pipe (verified 2026-06-11 against `T3 Code (Alpha)`):
//   - Focus a thread: there is no supported deep-link / focus command upstream, so
//     we `Page.navigate` the renderer to `/{environmentId}/{threadId}` + bringToFront.
//   - Create a thread / read status: rather than mint a bearer token (no `t3` CLI is
//     installed, and offline minting is impossible because the server's verify()
//     requires a live `auth_sessions` row), we run `fetch(..., {credentials:'include'})`
//     *inside the renderer page* over `Runtime.evaluate`. That rides the renderer's
//     existing same-origin session cookie — the exact call T3Code's own UI makes.
//
// This collapses the whole integration onto one constraint: "Hitch owns the T3Code
// process." When a *foreign* instance already holds T3Code's single-instance lock,
// Hitch can neither attach the pipe nor spawn its own — focus degrades to an OS
// window-reveal, and create degrades to a best-effort CLI-token path (see fallback).
//
// This module is deliberately self-contained (no new deps, hand-rolled CDP client)
// so it can be deleted wholesale once T3Code ships a supported focus/auth API. See
// the task file's "Upstream, in parallel" section.

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);

// TEMPORARY focus-path debug log (file so it can be read without the daemon's
// log UI). Remove once the focus issue is resolved.
const DEBUG_LOG = "/tmp/hitch-t3code-debug.log";
function dbg(message: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best-effort
  }
}

// ── Configuration / discovery ────────────────────────────────────────────────

// macOS bundle id (verified: com.t3tools.t3code) and product name. The installed
// build is "T3 Code (Alpha)"; allow override and scan /Applications so a renamed
// GA build keeps working.
const T3_BUNDLE_ID = "com.t3tools.t3code";
const T3_BASE_DIR = process.env.T3_BASE_DIR || join(homedir(), ".t3");
// Prod state dir is <base>/userdata; dev builds use <base>/dev.
const T3_STATE_DIR = join(T3_BASE_DIR, process.env.T3_DEV ? "dev" : "userdata");
const ENVIRONMENT_ID_PATH = join(T3_STATE_DIR, "environment-id");
const SERVER_RUNTIME_PATH = join(T3_STATE_DIR, "server-runtime.json");

function t3ExecutablePath(): string | null {
  if (process.env.T3CODE_BIN && existsSync(process.env.T3CODE_BIN)) {
    return process.env.T3CODE_BIN;
  }
  if (platform() !== "darwin") return null; // only macOS is supported for now
  let apps: string[] = [];
  try {
    apps = readdirSync("/Applications");
  } catch {
    return null;
  }
  // Prefer an exact known name, then any "T3 Code*.app" / "T3Code.app".
  const candidates = apps
    .filter((name) => /^t3 ?code.*\.app$/i.test(name))
    .sort((a, b) => a.length - b.length);
  for (const app of candidates) {
    const product = app.replace(/\.app$/i, "");
    const exec = join("/Applications", app, "Contents", "MacOS", product);
    if (existsSync(exec)) return exec;
  }
  return null;
}

export function isT3CodeInstalled(): boolean {
  return t3ExecutablePath() !== null;
}

// The environment id is global to an install (it is NOT in the snapshot). Needed to
// build the focus URL `/{environmentId}/{threadId}`.
export function readT3EnvironmentId(): string | null {
  try {
    const id = readFileSync(ENVIRONMENT_ID_PATH, "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

function readServerRuntime(): { origin: string; port: number; pid: number } | null {
  try {
    const raw = JSON.parse(readFileSync(SERVER_RUNTIME_PATH, "utf8")) as {
      origin?: string;
      port?: number;
      pid?: number;
    };
    if (!raw.origin || !raw.port) return null;
    return { origin: raw.origin, port: raw.port, pid: raw.pid ?? 0 };
  } catch {
    return null;
  }
}

// ── Minimal CDP-over-pipe client (NUL-delimited JSON over fds 3/4) ────────────

interface CdpLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

interface CdpPending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class CdpPipe {
  private child: ChildProcessWithoutNullStreams | null = null;
  private writePipe: NodeJS.WritableStream | null = null;
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private buf = Buffer.alloc(0);
  private exited = false;

  constructor(
    private readonly exec: string,
    private readonly logger?: CdpLogger,
  ) {}

  // Spawn the bundle executable with the debug pipe. fd 3 = browser input
  // (we write commands), fd 4 = browser output (we read responses/events).
  spawn(): void {
    const child = spawn(this.exec, ["--remote-debugging-pipe"], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.exited = false;

    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(
        `T3Code exited${signal ? ` (signal ${signal})` : ` (code ${code})`}`,
      );
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
        this.pending.delete(id);
      }
    });

    const writePipe = child.stdio[3] as NodeJS.WritableStream;
    const readPipe = child.stdio[4] as NodeJS.ReadableStream;
    this.writePipe = writePipe;
    readPipe.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  isAlive(): boolean {
    return Boolean(this.child) && !this.exited;
  }

  onExit(handler: () => void): void {
    this.child?.on("exit", handler);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let idx: number;
    while ((idx = this.buf.indexOf(0)) !== -1) {
      const line = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; error?: unknown; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      // Events (no id) are ignored — we poll Target.getTargets instead of
      // subscribing, keeping the client tiny.
    }
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 12_000,
  ): Promise<T> {
    if (!this.writePipe || this.exited) {
      return Promise.reject(new Error("T3Code CDP pipe is not connected"));
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.writePipe.write(`${JSON.stringify(message)}\0`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`T3Code CDP timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
    });
  }

  kill(): void {
    if (this.child && !this.exited) this.child.kill("SIGTERM");
  }
}

// ── Owned-process manager ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Thrown when a foreign T3Code instance holds the single-instance lock, so Hitch
// can neither attach a pipe nor spawn an instance it owns.
export class T3NotOwnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "T3NotOwnedError";
  }
}

interface OwnedSession {
  pipe: CdpPipe;
  // Current attached page-target session. NOT durable: the window can be closed
  // and reopened (which destroys the target and mints a new one), so this is
  // re-resolved per operation via ensurePageSession() rather than trusted.
  sessionId: string;
  targetId: string;
  origin: string; // e.g. http://127.0.0.1:3773
}

interface PageTarget {
  targetId: string;
  url: string;
}

interface PageFetchResult {
  status: number;
  json: unknown;
  text: string;
}

class T3CodeManager {
  private owned: OwnedSession | null = null;
  private ensuring: Promise<OwnedSession> | null = null;
  private logger?: CdpLogger;

  setLogger(logger: CdpLogger): void {
    this.logger = logger;
  }

  log(message: string): void {
    this.logger?.info(`[hitch:t3code] ${message}`);
    dbg(message);
  }

  isOwnedAlive(): boolean {
    return Boolean(this.owned?.pipe.isAlive());
  }

  // Ensure Hitch owns a live, CDP-attached, cookie-authenticated T3Code instance,
  // spawning one if nothing is running. Rejects with T3NotOwnedError if a foreign
  // instance holds the single-instance lock (our spawned child exits immediately).
  async ensure(): Promise<OwnedSession> {
    if (this.owned?.pipe.isAlive()) return this.owned;
    this.owned = null;
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<OwnedSession> {
    const exec = t3ExecutablePath();
    if (!exec) {
      throw new Error(
        "T3Code app not found (set T3CODE_BIN or install T3 Code into /Applications)",
      );
    }
    const pipe = new CdpPipe(exec, this.logger);
    pipe.spawn();
    this.log(`spawned T3Code (pid ${pipe.pid ?? "?"})`);

    // Find the loopback page target. If the child exits first, a foreign instance
    // took the single-instance lock and revealed its own window → not owned.
    const page = await this.waitForLoopbackPage(pipe);
    if (!page) {
      const childAlive = pipe.isAlive();
      this.log(
        `doEnsure: no loopback page (child ${childAlive ? "alive" : "exited"})`,
      );
      pipe.kill();
      if (!childAlive) {
        throw new T3NotOwnedError(
          "T3Code is already running (not launched by Hitch); cannot attach the debug pipe",
        );
      }
      throw new Error("T3Code did not expose a loopback page within timeout");
    }
    this.log(`doEnsure: attached to loopback page ${page.url}`);

    const { sessionId } = await pipe.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: page.targetId, flatten: true },
    );
    await pipe.send("Runtime.enable", {}, sessionId);
    await pipe.send("Page.enable", {}, sessionId);

    const origin = new URL(page.url).origin;
    const session: OwnedSession = {
      pipe,
      sessionId,
      targetId: page.targetId,
      origin,
    };

    // The renderer's session cookie isn't set the instant the page loads — wait
    // for the orchestration API to authorize us before any dispatch.
    await this.waitForCookieAuth(session);

    this.owned = session;
    this.log(`owns T3Code at ${origin}`);
    return session;
  }

  private async waitForLoopbackPage(
    pipe: CdpPipe,
  ): Promise<{ targetId: string; url: string } | null> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!pipe.isAlive()) return null;
      try {
        const { targetInfos } = await pipe.send<{
          targetInfos: { type: string; url: string; targetId: string }[];
        }>("Target.getTargets");
        const page = targetInfos.find(
          (t) => t.type === "page" && /^https?:\/\/127\.0\.0\.1:\d+/.test(t.url),
        );
        if (page) return { targetId: page.targetId, url: page.url };
      } catch {
        if (!pipe.isAlive()) return null;
      }
      await sleep(600);
    }
    return null;
  }

  private async waitForCookieAuth(session: OwnedSession): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await this.pageFetch(session, "/api/orchestration/snapshot");
      if (res.status === 200) return;
      await sleep(800);
    }
    throw new Error(
      "T3Code renderer never authorized the orchestration API (cookie session not ready)",
    );
  }

  // The set of live loopback page targets (the renderer windows). Re-queried per
  // operation because closing/reopening a window destroys its target and mints a
  // new one, and there can be more than one window.
  private async loopbackPages(pipe: CdpPipe): Promise<PageTarget[]> {
    const { targetInfos } = await pipe.send<{
      targetInfos: { type: string; url: string; targetId: string }[];
    }>("Target.getTargets");
    return targetInfos
      .filter(
        (t) => t.type === "page" && /^https?:\/\/127\.0\.0\.1:\d+/.test(t.url),
      )
      .map((t) => ({ targetId: t.targetId, url: t.url }));
  }

  // Return a usable page session, re-attaching if the cached target is gone (the
  // user closed/reopened the window → new target). If no window exists at all,
  // reveal one first. This is why a stale cached session never silently drives a
  // window the user isn't looking at.
  private async ensurePageSession(session: OwnedSession): Promise<string> {
    let pages = await this.loopbackPages(session.pipe);
    if (session.targetId && pages.some((p) => p.targetId === session.targetId)) {
      return session.sessionId;
    }
    if (pages.length === 0) {
      await revealT3Window();
      const deadline = Date.now() + 8_000;
      while (pages.length === 0 && Date.now() < deadline) {
        await sleep(500);
        pages = await this.loopbackPages(session.pipe);
      }
    }
    const target = pages[0];
    if (!target) throw new Error("T3Code has no renderer window to drive");
    const { sessionId } = await session.pipe.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
    );
    await session.pipe.send("Runtime.enable", {}, sessionId);
    await session.pipe.send("Page.enable", {}, sessionId);
    session.sessionId = sessionId;
    session.targetId = target.targetId;
    return sessionId;
  }

  // Run `fetch(path, {...init, credentials:'include'})` inside the renderer page
  // (rides the same-origin session cookie) and return the parsed JSON.
  async pageFetch(
    session: OwnedSession,
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<PageFetchResult> {
    const sessionId = await this.ensurePageSession(session);
    const expression = `(async()=>{
      const init = ${JSON.stringify(init)};
      const r = await fetch(${JSON.stringify(path)}, { ...init, credentials: 'include' });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j, text: t.slice(0, 2000) };
    })()`;
    const res = await session.pipe.send<{ result: { value: PageFetchResult } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    return res.result.value;
  }

  // Open a thread in the renderer. T3Code uses TanStack Router with a history that
  // does NOT sync window.location, so a CDP Page.navigate (which only changes
  // location.href) is ignored by the router — the view stays on "select a thread".
  // Instead we drive the app's OWN router (window.__TSR_ROUTER__.navigate), exactly
  // like clicking a thread does; falling back to clicking the thread-row element,
  // then to a hard location change. Runs against EVERY live loopback page target
  // (the cached one may be stale or a background window) and raises each.
  async navigate(
    session: OwnedSession,
    environmentId: string,
    threadId: string,
  ): Promise<void> {
    let pages = await this.loopbackPages(session.pipe);
    if (pages.length === 0) {
      await revealT3Window();
      const deadline = Date.now() + 8_000;
      while (pages.length === 0 && Date.now() < deadline) {
        await sleep(500);
        pages = await this.loopbackPages(session.pipe);
      }
    }
    this.log(
      `navigate → ${environmentId}/${threadId} (${pages.length} page target(s))`,
    );

    // NAV_TEMPLATE: the canonical thread route for this build. Configurable here
    // because T3Code's open PR #1493 may change it to /projects/$projectId/threads/$threadId.
    const fallbackUrl = `${session.origin}/${environmentId}/${threadId}`;
    const expression = `(async () => {
      try {
        const r = window.__TSR_ROUTER__;
        if (r && typeof r.navigate === 'function') {
          await r.navigate({
            to: '/$environmentId/$threadId',
            params: { environmentId: ${JSON.stringify(environmentId)}, threadId: ${JSON.stringify(threadId)} },
          });
          return 'router';
        }
      } catch (e) { /* fall through to DOM/href */ }
      const row = document.querySelector('[data-testid="thread-row-' + ${JSON.stringify(threadId)} + '"]');
      if (row) { row.click(); return 'click'; }
      window.location.href = ${JSON.stringify(fallbackUrl)};
      return 'href';
    })()`;

    const navigatedSessions: string[] = [];
    for (const page of pages) {
      try {
        const { sessionId } = await session.pipe.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: page.targetId, flatten: true },
        );
        await session.pipe.send("Page.enable", {}, sessionId);
        const res = await session.pipe.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        await session.pipe.send("Page.bringToFront", {}, sessionId);
        session.sessionId = sessionId;
        session.targetId = page.targetId;
        navigatedSessions.push(sessionId);
        this.log(`navigate: target ${page.targetId} via ${res.result.value}`);
      } catch (err) {
        this.log(`navigate: target ${page.targetId} failed: ${String(err)}`);
      }
    }
    if (navigatedSessions.length === 0) {
      throw new Error("T3Code has no renderer window to navigate");
    }
    // Read-back from the router (NOT location.href, which the app's router ignores)
    // to confirm the thread route resolved.
    await sleep(1000);
    for (const sessionId of navigatedSessions) {
      try {
        const rb = await session.pipe.send<{ result: { value: string } }>(
          "Runtime.evaluate",
          {
            expression:
              "(window.__TSR_ROUTER__ && window.__TSR_ROUTER__.state && window.__TSR_ROUTER__.state.location && window.__TSR_ROUTER__.state.location.pathname) || location.pathname",
            returnByValue: true,
          },
          sessionId,
        );
        this.log(`navigate read-back (router): ${rb.result.value}`);
      } catch {
        // ignore read-back failure
      }
    }
  }

  killOwned(): void {
    this.owned?.pipe.kill();
    this.owned = null;
  }
}

const manager = new T3CodeManager();

export function setT3Logger(logger: CdpLogger): void {
  manager.setLogger(logger);
}

// ── Snapshot read model (subset we use) ───────────────────────────────────────

interface ModelSelection {
  instanceId: string;
  model: string;
  options?: { id: string; value: string }[];
}

interface SnapshotProject {
  id: string;
  workspaceRoot?: string;
  repositoryIdentity?: { rootPath?: string };
  defaultModelSelection?: ModelSelection | null;
}

interface SnapshotThread {
  id: string;
  projectId: string;
  modelSelection?: ModelSelection;
  deletedAt?: string | null;
  latestTurn?: { state?: string } | null;
  session?: { status?: string } | null;
}

interface Snapshot {
  projects: SnapshotProject[];
  threads: SnapshotThread[];
}

async function fetchSnapshot(session: OwnedSession): Promise<Snapshot> {
  const res = await manager.pageFetch(session, "/api/orchestration/snapshot");
  if (res.status !== 200 || !res.json) {
    throw new Error(`T3Code snapshot failed (status ${res.status})`);
  }
  const j = res.json as Partial<Snapshot>;
  return { projects: j.projects ?? [], threads: j.threads ?? [] };
}

// POST one orchestration command through the renderer's cookie session.
async function dispatchCommand(
  session: OwnedSession,
  command: Record<string, unknown>,
): Promise<void> {
  const res = await manager.pageFetch(session, "/api/orchestration/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `T3Code dispatch failed for ${String(command.type)} (status ${res.status}): ${res.text}`,
    );
  }
}

function projectRoot(p: SnapshotProject): string | undefined {
  return p.repositoryIdentity?.rootPath ?? p.workspaceRoot;
}

// Discover the provider instanceId for a harness from selections T3Code already
// uses (verified instance ids: claude-code→"claudeAgent", codex→"codex"). We avoid
// hard-coding by scanning, but fall back to the known id when nothing's observed.
function resolveModelSelection(
  snapshot: Snapshot,
  harness: "claude-code" | "codex",
  preferred: { model?: string; effort?: string },
  projectDefault?: ModelSelection | null,
): ModelSelection {
  const selections: ModelSelection[] = [];
  for (const p of snapshot.projects) {
    if (p.defaultModelSelection) selections.push(p.defaultModelSelection);
  }
  for (const t of snapshot.threads) {
    if (t.modelSelection) selections.push(t.modelSelection);
  }

  const wantClaude = harness === "claude-code";
  const matchesHarness = (sel: ModelSelection) => {
    const id = sel.instanceId.toLowerCase();
    const model = sel.model.toLowerCase();
    const looksClaude =
      id.includes("claude") ||
      id.includes("anthropic") ||
      /opus|sonnet|haiku|fable|claude/.test(model);
    return wantClaude ? looksClaude : !looksClaude;
  };

  const match = selections.find(matchesHarness);
  const instanceId = match?.instanceId ?? (wantClaude ? "claudeAgent" : "codex");

  // Honor Hitch's model only if T3Code's instance is known to support it (an id
  // we've actually seen for this instance); otherwise reuse T3Code's own model so
  // the first turn doesn't fail on a cross-catalog model id.
  const observed = selections.filter((s) => s.instanceId === instanceId);
  const supported = new Set(observed.map((s) => s.model));
  let model: string;
  if (preferred.model && supported.has(preferred.model)) {
    model = preferred.model;
  } else if (match) {
    model = match.model;
  } else if (observed[0]) {
    model = observed[0].model;
  } else {
    model = projectDefault?.model ?? (wantClaude ? "claude-opus-4-7" : "gpt-5.5");
  }

  const selection: ModelSelection = { instanceId, model };
  // Codex carries reasoning effort as a provider option; claudeAgent had none, so
  // only attach it for codex to avoid an unrecognized option.
  if (!wantClaude && preferred.effort) {
    selection.options = [{ id: "reasoningEffort", value: preferred.effort }];
  }
  return selection;
}

// ── Public API used by the launchers ─────────────────────────────────────────

export interface T3StartSpec {
  taskKey: string;
  prompt: string;
  cwd: string;
  harness: "claude-code" | "codex";
  threadName?: string;
  model?: string;
  effort?: string;
  onLinked: (threadId: string, environmentId: string) => Promise<void>;
}

export interface T3StartResult {
  threadId: string;
  environmentId: string;
}

const recentStarts = new Map<string, { result: T3StartResult; at: number }>();
const START_GRACE_MS = 45_000;

// Create a T3Code thread and run its first turn, all through the renderer's
// cookie session over CDP. Generates the thread/command/message ids client-side.
export async function startT3Chat(spec: T3StartSpec): Promise<T3StartResult> {
  const recent = recentStarts.get(spec.taskKey);
  if (recent && Date.now() - recent.at < START_GRACE_MS) return recent.result;

  const environmentId = readT3EnvironmentId();
  if (!environmentId) {
    throw new Error(
      "T3Code environment id not found at ~/.t3/userdata/environment-id; open T3Code once to initialize it",
    );
  }

  let session: OwnedSession;
  try {
    session = await manager.ensure();
  } catch (err) {
    if (err instanceof T3NotOwnedError) {
      // Fallback corner: a foreign T3Code instance is running. Creating a chat
      // there needs a daemon→server bearer token (best-effort CLI path).
      manager.log(`startT3Chat: ensure() → NotOwned, using token fallback (${String(err)})`);
      return startT3ChatViaToken(spec, environmentId);
    }
    throw err;
  }
  manager.log(`startT3Chat: owned path (origin ${session.origin})`);

  const snapshot = await fetchSnapshot(session);
  const project = snapshot.projects.find((p) => projectRoot(p) === spec.cwd);
  const modelSelection = resolveModelSelection(
    snapshot,
    spec.harness,
    { model: spec.model, effort: spec.effort },
    project?.defaultModelSelection,
  );

  const projectId = project?.id ?? (await createProject(session, spec, modelSelection));
  const threadId = randomUUID();
  const title = (spec.threadName || "Hitch task").trim() || "Hitch task";
  const createdAt = new Date().toISOString();

  // The HTTP dispatch endpoint runs commands straight through the decider and
  // does NOT expand `bootstrap.createThread` (that only happens on the WS path,
  // ws.ts). So replicate what the server does internally: create the thread,
  // then start the turn. Verified end-to-end against the live build 2026-06-11.
  // OQ2: run in the project root (no worktree) to match Hitch's chat-cwd = repo
  // root assumption — branch/worktreePath null, no prepareWorktree.
  await dispatchCommand(session, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  await dispatchCommand(session, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: spec.prompt,
      attachments: [],
    },
    modelSelection,
    titleSeed: title,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  const result: T3StartResult = { threadId, environmentId };
  recentStarts.set(spec.taskKey, { result, at: Date.now() });
  await spec.onLinked(threadId, environmentId);
  // Bring the thread to the front so the user lands on it.
  await manager.navigate(session, environmentId, threadId);
  await activateApp();
  return result;
}

async function createProject(
  session: OwnedSession,
  spec: T3StartSpec,
  modelSelection: ModelSelection,
): Promise<string> {
  const projectId = randomUUID();
  await dispatchCommand(session, {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: spec.cwd.split("/").pop() || "Hitch project",
    workspaceRoot: spec.cwd,
    createWorkspaceRootIfMissing: false,
    defaultModelSelection: modelSelection,
    createdAt: new Date().toISOString(),
  });
  return projectId;
}

export type T3FocusOutcome =
  | { kind: "focused" }
  | { kind: "revealed" } // window brought forward, but couldn't navigate to the thread
  | { kind: "unavailable"; reason: string };

// Focus a specific thread. If Hitch can own a live instance (reusing one it owns,
// or spawning one when nothing is running) we navigate to the thread. If a foreign
// instance holds the lock, we can only reveal its window (the degraded path).
export async function focusT3Thread(input: {
  environmentId: string;
  threadId: string;
}): Promise<T3FocusOutcome> {
  let session: OwnedSession;
  try {
    session = await manager.ensure();
  } catch (err) {
    if (err instanceof T3NotOwnedError) {
      const revealed = await revealT3Window();
      return revealed
        ? { kind: "revealed" }
        : { kind: "unavailable", reason: String(err) };
    }
    return { kind: "unavailable", reason: String(err) };
  }
  await manager.navigate(session, input.environmentId, input.threadId);
  await activateApp();
  return { kind: "focused" };
}

// Bring a foreign (not Hitch-owned) T3Code window forward via macOS `open -b`,
// which activates the running app without spawning a second instance.
async function revealT3Window(): Promise<boolean> {
  if (platform() !== "darwin") return false;
  try {
    await run("/usr/bin/open", ["-b", T3_BUNDLE_ID], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function activateApp(): Promise<void> {
  if (platform() !== "darwin") return;
  try {
    await run("/usr/bin/open", ["-b", T3_BUNDLE_ID], { timeout: 5_000 });
  } catch {
    // best-effort foreground; bringToFront already raised the page
  }
}

// ── Status from T3Code's read model ───────────────────────────────────────────

export type T3ChatStatus = "working" | "waiting";

// Map a thread's snapshot state to Hitch's chat-status. We don't surface
// "needs-input": the snapshot fields we have (latestTurn.state, session.status)
// don't cleanly signal a permission/approval block, so we only distinguish
// working vs waiting. Returns null when the thread isn't found or we don't own a
// live instance to read from.
export async function latestT3Status(threadId: string): Promise<T3ChatStatus | null> {
  if (!manager.isOwnedAlive()) return null;
  let session: OwnedSession;
  try {
    session = await manager.ensure();
  } catch {
    return null;
  }
  const snapshot = await fetchSnapshot(session);
  const thread = snapshot.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  const turn = thread.latestTurn?.state;
  const sess = thread.session?.status;
  if (turn === "running" || sess === "running" || sess === "starting") {
    return "working";
  }
  return "waiting";
}

export async function closeT3Code(): Promise<void> {
  manager.killOwned();
}

// ── Fallback: daemon→server dispatch with a CLI-minted token ──────────────────
//
// Used ONLY when a foreign T3Code instance is already running (Hitch can't own it
// via the pipe). Best-effort: needs a `t3` CLI (on PATH or via `npx -y t3`) and a
// `server-runtime.json` to discover the origin. If anything is missing we degrade
// with an actionable error rather than hard-failing. Delete this with the rest of
// the module once upstream ships a focus/auth API.

async function startT3ChatViaToken(
  spec: T3StartSpec,
  environmentId: string,
): Promise<T3StartResult> {
  const runtime = readServerRuntime();
  const token = runtime ? await mintT3Token() : null;
  if (!runtime || !token) {
    throw new Error(
      "T3Code is already running but wasn't launched by Hitch. Open T3Code from Hitch " +
        "to create chats with full thread focus (or install the `t3` CLI to enable the " +
        "fallback create path).",
    );
  }

  const snapshot = await fetchSnapshotHttp(runtime.origin, token);
  const project = snapshot.projects.find((p) => projectRoot(p) === spec.cwd);
  const modelSelection = resolveModelSelection(
    snapshot,
    spec.harness,
    { model: spec.model, effort: spec.effort },
    project?.defaultModelSelection,
  );
  if (!project) {
    throw new Error(
      "T3Code (foreign instance): no matching project for this repo. Open it in T3Code first.",
    );
  }

  const threadId = randomUUID();
  const title = (spec.threadName || "Hitch task").trim() || "Hitch task";
  const createdAt = new Date().toISOString();
  // Same two-step sequence as the owned path (HTTP doesn't expand bootstrap).
  await dispatchCommandHttp(runtime.origin, token, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId: project.id,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  await dispatchCommandHttp(runtime.origin, token, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: spec.prompt, attachments: [] },
    modelSelection,
    titleSeed: title,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const result: T3StartResult = { threadId, environmentId };
  await spec.onLinked(threadId, environmentId);
  await revealT3Window();
  return result;
}

async function fetchSnapshotHttp(origin: string, token: string): Promise<Snapshot> {
  const resp = await fetch(`${origin}/api/orchestration/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`T3Code snapshot (token) failed: ${resp.status}`);
  const j = (await resp.json()) as Partial<Snapshot>;
  return { projects: j.projects ?? [], threads: j.threads ?? [] };
}

async function dispatchCommandHttp(
  origin: string,
  token: string,
  command: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`${origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  });
  if (!resp.ok) {
    throw new Error(
      `T3Code dispatch (token) failed for ${String(command.type)}: ${resp.status} ${await resp.text()}`,
    );
  }
}

let cachedToken: { token: string; at: number } | null = null;
const TOKEN_TTL_MS = 30 * 60_000;

// Best-effort: shell out to the `t3` CLI to mint a scoped bearer token. The CLI
// writes a session row to T3Code's SQLite (the only legitimate way to get a token
// the server's verify() will honor — offline minting is impossible). Returns null
// if no usable `t3` CLI is available.
async function mintT3Token(): Promise<string | null> {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) {
    return cachedToken.token;
  }
  const baseArgs = [
    "auth",
    "session",
    "issue",
    "--token-only",
    "--base-dir",
    T3_BASE_DIR,
  ];
  const attempts: [string, string[]][] = [
    ["t3", baseArgs],
    ["npx", ["-y", "t3", ...baseArgs]],
  ];
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await run(bin, args, { timeout: 60_000 });
      const token = stdout.trim().split(/\s+/).pop() ?? "";
      if (token) {
        cachedToken = { token, at: Date.now() };
        return token;
      }
    } catch {
      // try the next strategy
    }
  }
  return null;
}
