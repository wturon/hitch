// The chat observer — one tick, one snapshot.
//
// docs/chat-tracking-redesign.md §5–§7. Every tick this builds the WHOLE
// working set and hands it to `publish`, which PUTs it to
// /daemon/machines/:id/chat-snapshot. There is no local chat model, no event
// ledger and no reducer: **a chat missing from the snapshot is no longer live**,
// and that is the entire heal path.
//
// The six rules this file has to obey:
//   1. One pipeline. Discovery and (later) launch pre-registration land in the
//      same tracked set and are observed identically.
//   2. Environment-blind. Zero imports from launchers/ or cmux.
//   3. The working set is bounded — live processes plus transcripts touched
//      inside a 24 h recency window, hard-capped. Aging out is not deletion.
//   4. Snapshot, not deltas.
//   5. Hooks are a nudge: they report `block` and wake the loop early. Lose
//      every hook and status is still correct, just later.
//   6. Status is decided on the server. We report three axes and never a status.

import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import {
  activityFromPidfileStatus,
  claudeAgentsFallback,
  claudeHome,
  claudeTranscriptCwd,
  deriveClaudeTranscriptActivity,
  discoverClaudeSessions,
  findClaudeTranscript,
  readClaudePidfiles,
  scanClaudeTranscripts,
  sessionsDir,
  type ClaudeSession,
  type ClaudeTranscript,
} from "./claudeObserver.js";
import {
  codexHome,
  deriveCodexRolloutActivity,
  readCodexThreads,
  type CodexThread,
} from "./codexObserver.js";
import { CursorStore } from "./cursors.js";
import {
  codexResumeThreadId,
  codexTuiProcesses,
  snapshotProcesses,
  startTimesAgree,
  type ProcessInfo,
} from "./liveness.js";
import { projectForCwd, type ObserverProject } from "./projects.js";
import { EventSpool, type SpooledEvent } from "./spool.js";
import { readLatestTail, type TailCursor } from "./tail.js";
import type {
  ChatSnapshot,
  JsonObject,
  JsonValue,
  ObservationEvidence,
  ObservedActivity,
  ObservedBlock,
  ObservedChat,
  SnapshotEvent,
  SnapshotHarness,
} from "./types.js";

export interface ChatObserverLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface ChatObserverOptions {
  /** Spool dir + cursors.json, from resolveSpoolPaths(). */
  paths: { eventsDir: string; cursorsPath: string };
  /** Live array of {projectId, localPath}; mutated in place by ProjectsProvider. */
  projects: ObserverProject[];
  host: string;
  logger: ChatObserverLogger;
  /** Ship one snapshot. Throwing is logged, never fatal. */
  publish: (snapshot: ChatSnapshot) => Promise<void> | void;
  now?: () => number;
  windowMs?: number;
  cap?: number;
}

// --- cadence (unchanged from the level-triggered observer; §8 "keep") --------
// Trailing settle before a file-derived `working` chat becomes `idle`. The
// leading edge (a new byte / a "busy" self-report) flips to working instantly.
const SETTLE_MS = 3_000;
const ACTIVE_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 30_000;
const WATCH_DEBOUNCE_MS = 250;
// A chat must miss the derived set this many CONSECUTIVE ticks before it leaves
// the snapshot. The server acts on the FIRST absence, so this debounce is the
// only thing standing between a transient read failure and a false death.
const DEAD_MISS_THRESHOLD = 2;

// --- bounds (§8 "add": the missing bound) -----------------------------------
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_CAP = 60;
// Codex's own catalog is read newest-first and bounded before the window filter.
const CODEX_THREAD_LIMIT = 200;
// A Codex thread counts as possibly-running only if its rollout moved this
// recently AND a live `codex` process shares its cwd.
const CODEX_RUNNING_FRESH_MS = 60_000;
// Dormant Claude discovery walks ~/.claude/projects — far too heavy for the 1 s
// active cadence, and dormancy by definition doesn't change fast.
const DORMANT_SCAN_MS = 30_000;
const DORMANT_SCAN_LIMIT = 200;
// `claude agents --json` costs ~190 ms. It is a FALLBACK for a CLI too old to
// write pidfiles at all, rate-limited hard and never on the normal path.
const AGENTS_FALLBACK_MS = 60_000;
// Cursors for chats we haven't touched in a day are dead weight.
const CURSOR_TTL_MS = DEFAULT_WINDOW_MS;
// How long a hook event's block belief waits for its chat to be discovered
// (a Codex thread lands in state_5.sqlite a moment after its first prompt).
const EVENT_ORPHAN_TTL_MS = 5 * 60_000;

interface ChatRuntime {
  createdAt: number;
  lastWorkingAt: number;
  misses: number;
  /** Hook-owned. Undefined = we have no belief and must not overwrite the server's. */
  block?: ObservedBlock | null;
  /** The last observation we published, for the 2-miss carry-over. */
  last?: ObservedChat;
}

const chatKey = (harness: SnapshotHarness, sessionId: string) => `${harness}:${sessionId}`;

// Hook harness vocabulary ("claude-code") → wire vocabulary ("claude").
function wireHarness(harness: string): SnapshotHarness {
  return harness === "codex" ? "codex" : "claude";
}

const TITLE_MAX = 72;
function cleanTitle(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= TITLE_MAX
    ? normalized
    : `${normalized.slice(0, TITLE_MAX - 3).trimEnd()}...`;
}

// Maps a Claude pidfile `entrypoint` to an environment hint. Evidence only —
// nothing downstream branches on it (that's the attachment layer's job).
function claudeEnvironment(entrypoint: string | null): string | null {
  if (entrypoint === "claude-vscode") return "vscode";
  return null;
}

// A hook event's `lifecycle` is the block signal (§3: hooks are the ONLY source
// that can see a block — a permission prompt and a slow tool call are
// indistinguishable on disk). `turn.needs_input` raises it; literally anything
// else from that chat means the harness moved on, which clears it.
function blockFromLifecycle(lifecycle: string): ObservedBlock | null {
  return lifecycle === "turn.needs_input" ? "permission" : null;
}

// The hook's metadata is untrusted JSON from disk. Flatten it to scalars so a
// nested surprise can't fail the server's payload validation.
function jsonScalars(value: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw as JsonValue;
    }
  }
  return out;
}

export class ChatObserver {
  private readonly projects: ObserverProject[];
  private readonly host: string;
  private readonly logger: ChatObserverLogger;
  private readonly publish: ChatObserverOptions["publish"];
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly cap: number;

  private readonly cursors: CursorStore;
  private readonly spool: EventSpool;
  private readonly runtime = new Map<string, ChatRuntime>();
  // A session's transcript never moves, so resolve the glob once.
  private readonly transcriptPaths = new Map<string, string | null>();
  private readonly transcriptCwds = new Map<string, string | null>();
  private readonly loggedUnknownProjects = new Set<string>();

  private dormantScan: ClaudeTranscript[] = [];
  private dormantScannedAt = 0;
  private agentsFallbackAt = 0;

  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(options: ChatObserverOptions) {
    this.projects = options.projects;
    this.host = options.host;
    this.logger = options.logger;
    this.publish = options.publish;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.cap = options.cap ?? DEFAULT_CAP;
    this.cursors = new CursorStore(options.paths.cursorsPath);
    this.spool = new EventSpool({
      dir: options.paths.eventsDir,
      onWake: () => void this.tick("spool"),
      debounceMs: WATCH_DEBOUNCE_MS,
    });
  }

  start(): void {
    this.spool.start();
    this.startWatchers();
    void this.tick("startup");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.spool.stop();
    this.cursors.flush();
    await Promise.all(this.watchers.map((w) => w.close().catch(() => {})));
    this.watchers = [];
  }

  /** One tick on demand — the disposability smoke drives the observer through this. */
  async runOnce(reason = "manual"): Promise<void> {
    await this.tick(reason, { schedule: false });
  }

  // --- watchers (fast path) --------------------------------------------------

  private startWatchers(): void {
    // Watch parent directories, not files: atomic-rename/truncation/inode
    // changes break file-level watches. `depth` keeps us off the deep transcript
    // sub-trees. Errors are logged, never thrown — a missing dir just means that
    // harness isn't in use yet, and the tick floor still covers correctness if a
    // watcher dies (e.g. inotify ENOSPC on Linux).
    const targets: Array<{ path: string; depth: number }> = [
      { path: join(claudeHome(), "projects"), depth: 1 },
      { path: sessionsDir(), depth: 0 },
      { path: join(codexHome(), "sessions"), depth: 4 },
    ];
    for (const target of targets) {
      try {
        const watcher = chokidar.watch(target.path, {
          ignoreInitial: true,
          depth: target.depth,
        });
        watcher
          .on("add", () => this.onWatchEvent())
          .on("change", () => this.onWatchEvent())
          .on("unlink", () => this.onWatchEvent())
          .on("error", (err) =>
            this.logger.error?.(`[observer] watcher error on ${target.path}: ${String(err)}`),
          );
        this.watchers.push(watcher);
      } catch (err) {
        this.logger.error?.(`[observer] failed to watch ${target.path}: ${String(err)}`);
      }
    }
  }

  private onWatchEvent(): void {
    if (this.stopped) return;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      void this.tick("watch");
    }, WATCH_DEBOUNCE_MS);
  }

  private scheduleNext(anyWorking: boolean): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const base = anyWorking ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    // ±20% jitter on the idle interval so many daemons don't tick in lockstep;
    // none on the tight active cadence.
    const jitter = base > ACTIVE_INTERVAL_MS ? base * 0.2 * (Math.random() - 0.5) : 0;
    // Deliberately NOT unref'd (matching the observer this replaces): the tick
    // is the daemon's correctness floor, so it should hold the process open.
    this.timer = setTimeout(
      () => void this.tick("interval"),
      Math.max(ACTIVE_INTERVAL_MS, Math.round(base + jitter)),
    );
  }

  // --- the tick --------------------------------------------------------------

  private async tick(reason: string, options: { schedule?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    let anyWorking = false;
    try {
      const snapshot = await this.build();
      anyWorking = snapshot.chats.some(
        (c) => c.existence === "running" && (c.activity === "working" || c.block != null),
      );
      await this.publish(snapshot);
    } catch (err) {
      this.logger.error?.(`[observer] tick failed (${reason}): ${String(err)}`);
    } finally {
      this.cursors.flush();
      this.running = false;
      if (options.schedule !== false) this.scheduleNext(anyWorking);
      if (this.rerun) {
        this.rerun = false;
        if (options.schedule !== false) queueMicrotask(() => void this.tick("rerun"));
      }
    }
  }

  private async build(): Promise<ChatSnapshot> {
    const now = this.now();
    const windowStart = now - this.windowMs;

    // 1. Drain the inbox. Events are relayed verbatim AND folded into the
    //    hook-owned `block` axis. They are gone from disk either way.
    const drained = this.spool.drain();
    if (drained.malformed > 0) {
      this.logger.error?.(`[observer] dropped ${drained.malformed} malformed spool file(s)`);
    }
    const events = this.foldEvents(drained.events);

    // 2. One `ps` for the whole tick. An EMPTY result means the snapshot itself
    //    failed — every chat would look dead — so we flag coverage incomplete
    //    and the server skips its sweep entirely rather than mass-killing.
    const processes = await snapshotProcesses();
    const processesUnknown = processes.length === 0;

    const chats = new Map<string, ObservedChat>();
    for (const chat of await this.observeClaude(processes, now)) {
      chats.set(chatKey(chat.harness, chat.sessionId), chat);
    }
    // A Claude chat we had as `running` that is no longer live has almost
    // certainly just gone dormant, not vanished. Force the (otherwise
    // rate-limited) transcript scan so it transitions running → dormant on THIS
    // tick, instead of flickering out of the snapshot — and reading as dead —
    // until the next scheduled scan.
    const lostRunning = [...this.runtime].some(
      ([key, rt]) =>
        rt.last?.harness === "claude" &&
        rt.last.existence === "running" &&
        !chats.has(key),
    );
    for (const chat of this.observeClaudeDormant(now, windowStart, chats, lostRunning)) {
      chats.set(chatKey(chat.harness, chat.sessionId), chat);
    }
    for (const chat of this.observeCodex(processes, now, windowStart)) {
      chats.set(chatKey(chat.harness, chat.sessionId), chat);
    }

    // 3. Two-miss debounce. A chat that vanished for exactly one tick is
    //    re-published from its last observation; on the second consecutive miss
    //    it leaves the snapshot and the server marks it dead.
    const carried = this.applyMissDebounce(chats, processesUnknown);

    // 4. Attach the hook-owned block, then bound the set.
    const all = [...chats.values(), ...carried];
    for (const chat of all) {
      const rt = this.runtime.get(chatKey(chat.harness, chat.sessionId));
      if (rt && "block" in rt) chat.block = rt.block ?? null;
    }
    const ranked = all.sort((a, b) => rank(b) - rank(a) || seenAt(b) - seenAt(a));
    const truncated = processesUnknown || ranked.length > this.cap;
    const selected = ranked.slice(0, this.cap);
    for (const chat of selected) {
      const rt = this.ensureRuntime(chatKey(chat.harness, chat.sessionId));
      rt.last = chat;
    }

    this.cursors.prune(CURSOR_TTL_MS, now);

    return {
      observedAt: new Date(now).toISOString(),
      window: {
        since: new Date(windowStart).toISOString(),
        cap: this.cap,
        truncated,
      },
      chats: selected,
      // Only relay events for chats that made the cut — anything else has no
      // row on the server to hang off and would just be counted as dropped.
      events: events.filter((e) =>
        selected.some((c) => c.harness === e.harness && c.sessionId === e.sessionId),
      ),
    };
  }

  // --- events ----------------------------------------------------------------

  // Relay verbatim, and fold the block axis. NOTE: we do NOT rename kinds to
  // `block.*` on the wire — the server's `block.*` handling is an alternative to
  // this path, and sending both would double-write the same fact. The lifecycle
  // names are the useful history; the block belief rides on the chat.
  private foldEvents(drained: SpooledEvent[]): SnapshotEvent[] {
    const out: SnapshotEvent[] = [];
    for (const event of drained) {
      const harness = wireHarness(event.harness);
      const rt = this.ensureRuntime(chatKey(harness, event.chatId));
      rt.block = blockFromLifecycle(event.lifecycle);
      out.push({
        sessionId: event.chatId,
        harness,
        kind: event.lifecycle,
        at: new Date(event.observedAt).toISOString(),
        payload: {
          providerEvent: event.providerEvent,
          producer: event.producer,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.launchId ? { launchId: event.launchId } : {}),
          ...jsonScalars(event.metadata),
        },
      });
    }
    return out;
  }

  // --- Claude ----------------------------------------------------------------

  private async observeClaude(processes: ProcessInfo[], now: number): Promise<ObservedChat[]> {
    let pidfiles = readClaudePidfiles();
    if (pidfiles.length === 0 && now - this.agentsFallbackAt > AGENTS_FALLBACK_MS) {
      // No pidfiles at all — either nothing is running, or this CLI predates
      // them. Pay the ~190 ms once a minute to find out, never per tick.
      this.agentsFallbackAt = now;
      pidfiles = await claudeAgentsFallback();
    }
    const byPid = new Map(processes.map((p) => [p.pid, p] as const));
    const sessions = discoverClaudeSessions(processes, pidfiles);

    const out: ObservedChat[] = [];
    for (const session of sessions) {
      if (!session.alive) continue;
      // The start-time half of process identity: a recycled pid is a process
      // that started much later than the one the pidfile recorded.
      const live = byPid.get(session.pid);
      if (live && !startTimesAgree(session.startedAt, live.startedAt)) continue;
      out.push(this.claudeChat(session, now));
    }
    return out;
  }

  private claudeChat(session: ClaudeSession, now: number): ObservedChat {
    const key = chatKey("claude", session.sessionId);
    let raw = activityFromPidfileStatus(session.status);
    const evidence: ObservationEvidence = {
      pidfileStatus: session.status,
      entrypoint: session.entrypoint,
      environment: claudeEnvironment(session.entrypoint),
      kind: session.kind,
      pid: session.pid,
    };

    // The pidfile's self-report is the harness's own truth, so we only pay for
    // a transcript read when there ISN'T one (vscode reports null). That keeps
    // the 1 s cadence to one small JSON read per live chat.
    let source: ObservedChat["source"] = "claude-pidfile";
    let changed = false;
    if (raw === "unknown") {
      source = "claude-transcript";
      const transcript = this.transcriptFor(session.sessionId);
      if (transcript) {
        changed = this.tail(key, transcript, (lines) => {
          const derived = deriveClaudeTranscriptActivity(lines);
          raw = derived.activity;
          evidence.lastStopReason = derived.lastStopReason;
        });
      }
    }

    return {
      harness: "claude",
      sessionId: session.sessionId,
      cwd: session.cwd || null,
      process: { pid: session.pid, startedAt: session.startedAt },
      existence: "running",
      activity: this.debounceActivity(key, raw, changed, now),
      source,
      evidence,
      projectId: this.projectFor(session.cwd, "claude", session.sessionId),
      ...(cleanTitle(session.name) ? { title: cleanTitle(session.name) } : {}),
    };
  }

  // Transcripts touched inside the window with no live process. Rate-limited:
  // dormancy doesn't change on a 1 s timescale, and walking ~/.claude/projects
  // is the most expensive thing here.
  private observeClaudeDormant(
    now: number,
    windowStart: number,
    already: Map<string, ObservedChat>,
    force = false,
  ): ObservedChat[] {
    if (force || now - this.dormantScannedAt > DORMANT_SCAN_MS) {
      this.dormantScannedAt = now;
      this.dormantScan = scanClaudeTranscripts(windowStart, DORMANT_SCAN_LIMIT);
    }
    const out: ObservedChat[] = [];
    for (const transcript of this.dormantScan) {
      if (transcript.mtimeMs < windowStart) continue;
      if (already.has(chatKey("claude", transcript.sessionId))) continue;
      const cwd = this.transcriptCwdFor(transcript.sessionId, transcript.path);
      out.push({
        harness: "claude",
        sessionId: transcript.sessionId,
        cwd,
        process: null,
        existence: "dormant",
        // Dormant is idle by definition — nothing is running to be working.
        activity: "idle",
        source: "claude-dormant",
        evidence: {
          mtimeAge: Math.round((now - transcript.mtimeMs) / 1000),
          size: transcript.size,
        },
        projectId: this.projectFor(cwd ?? "", "claude", transcript.sessionId),
      });
    }
    return out;
  }

  private transcriptFor(sessionId: string): string | null {
    const cached = this.transcriptPaths.get(sessionId);
    if (cached !== undefined && cached !== null) return cached;
    const found = findClaudeTranscript(sessionId);
    // Cache misses too, but re-resolve them next tick: a brand-new session's
    // transcript appears a moment after the pidfile does.
    if (found) this.transcriptPaths.set(sessionId, found);
    return found;
  }

  private transcriptCwdFor(sessionId: string, path: string): string | null {
    const cached = this.transcriptCwds.get(sessionId);
    if (cached !== undefined) return cached;
    const cwd = claudeTranscriptCwd(path);
    this.transcriptCwds.set(sessionId, cwd);
    return cwd;
  }

  // --- Codex -----------------------------------------------------------------

  // Codex's catalog carries no process information, so existence needs the
  // process table (see codexObserver.ts's header). Two signals, strongest first:
  //   `codex resume <id>` in a live argv  → definitive, and gives us a pid.
  //   a live codex TUI in the thread's cwd + a fresh rollout → running.
  // Everything else inside the window is dormant.
  private observeCodex(processes: ProcessInfo[], now: number, windowStart: number): ObservedChat[] {
    const threads = readCodexThreads(CODEX_THREAD_LIMIT);
    const tui = codexTuiProcesses(processes);
    const out: ObservedChat[] = [];
    for (const thread of threads) {
      if (thread.archived) continue;
      if (thread.updatedAtMs < windowStart) continue;
      out.push(this.codexChat(thread, tui, now));
    }
    return out;
  }

  private codexChat(thread: CodexThread, tui: ProcessInfo[], now: number): ObservedChat {
    const key = chatKey("codex", thread.id);
    const resumeProc =
      tui.find((p) => codexResumeThreadId(p.command) === thread.id.toLowerCase()) ?? null;
    const fresh = now - thread.updatedAtMs < CODEX_RUNNING_FRESH_MS;
    const cwdMatch = !!thread.cwd && tui.some((p) => p.command.includes(thread.cwd));
    const existence = resumeProc || (fresh && cwdMatch) ? "running" : "dormant";

    const evidence: ObservationEvidence = {
      resumeMatch: !!resumeProc,
      cwdMatch,
      updatedAtMs: thread.updatedAtMs,
      mtimeAge: Math.round((now - thread.updatedAtMs) / 1000),
      threadSource: thread.source,
    };

    // Only tail plausibly-running threads. A dormant thread is idle regardless
    // of its last turn, so re-reading its rollout every tick is wasted I/O —
    // without this gate a heavy user pays ~200 × 128 KB reads per tick.
    let raw: ObservedActivity = "unknown";
    let changed = false;
    let source: ObservedChat["source"] = "codex-sqlite";
    if (existence === "running") {
      changed = this.tail(key, thread.rolloutPath, (lines) => {
        const derived = deriveCodexRolloutActivity(lines);
        raw = derived.activity;
        evidence.marker = derived.marker;
      });
      source = "codex-rollout";
    }

    return {
      harness: "codex",
      sessionId: thread.id,
      cwd: thread.cwd || null,
      process: resumeProc ? { pid: resumeProc.pid, startedAt: resumeProc.startedAt } : null,
      existence,
      activity: existence === "running" ? this.debounceActivity(key, raw, changed, now) : "idle",
      source,
      evidence,
      projectId: this.projectFor(thread.cwd, "codex", thread.id),
      ...(cleanTitle(thread.title) ? { title: cleanTitle(thread.title) } : {}),
    };
  }

  // --- shared helpers --------------------------------------------------------

  // Level-triggered tail: re-read the current bounded window every tick and hand
  // its complete lines to `consume`, so derivation reflects the PRESENT
  // latest-turn state rather than only newly-appended bytes. The persisted
  // cursor (dev/ino/size/mtime, now in cursors.json) only answers "did this file
  // move since last tick" — the leading-edge working trigger. Returns that flag.
  private tail(key: string, path: string, consume: (lines: string[]) => void): boolean {
    const prior = this.cursors.get(key);
    const priorCursor: TailCursor | null = prior
      ? {
          dev: prior.dev,
          ino: prior.ino,
          offset: prior.offset,
          size: prior.size,
          mtimeMs: prior.mtimeMs,
        }
      : null;
    const result = readLatestTail(path, priorCursor);
    if (!result) return false;
    if (result.lines.length > 0) consume(result.lines);
    this.cursors.set(key, { ...result.cursor, seenAt: this.now() });
    return result.changed;
  }

  // Asymmetric debounce: working is a leading edge (instant); idle needs a
  // trailing settle so we don't flap between a turn's tool calls.
  private debounceActivity(
    key: string,
    raw: ObservedActivity,
    fileChanged: boolean,
    now: number,
  ): ObservedActivity {
    const rt = this.ensureRuntime(key);
    if (raw === "working" || fileChanged) {
      rt.lastWorkingAt = now;
      return "working";
    }
    if (now - rt.lastWorkingAt < SETTLE_MS) return "working";
    return raw; // "idle" or "unknown" — both resolve to idle on the server
  }

  private ensureRuntime(key: string): ChatRuntime {
    const existing = this.runtime.get(key);
    if (existing) return existing;
    const fresh: ChatRuntime = { createdAt: this.now(), lastWorkingAt: 0, misses: 0 };
    this.runtime.set(key, fresh);
    return fresh;
  }

  // The 2-miss debounce. Absence from ONE tick is a read failure as often as a
  // death, and the server acts on first absence — so the tolerance has to live
  // here.
  private applyMissDebounce(
    present: Map<string, ObservedChat>,
    processesUnknown: boolean,
  ): ObservedChat[] {
    const carried: ObservedChat[] = [];
    for (const [key, rt] of this.runtime) {
      if (present.has(key)) {
        rt.misses = 0;
        continue;
      }
      if (!rt.last) {
        // An event arrived for a chat we can't see yet — a Codex thread whose
        // row hasn't landed in state_5.sqlite, say. Hold its block belief for a
        // grace period so it's attached the moment the chat appears, then
        // forget it rather than leaking the map.
        if (this.now() - rt.createdAt > EVENT_ORPHAN_TTL_MS) this.runtime.delete(key);
        continue;
      }
      // Coverage is unknowable this tick — don't spend a miss on it.
      if (processesUnknown) {
        carried.push({ ...rt.last, source: "carry-over" });
        continue;
      }
      rt.misses += 1;
      if (rt.misses < DEAD_MISS_THRESHOLD) {
        carried.push({
          ...rt.last,
          source: "carry-over",
          evidence: { ...rt.last.evidence, missed: rt.misses },
        });
        continue;
      }
      // Confirmed gone: forget everything about it, INCLUDING the block — a
      // block never outlives the process that raised it.
      this.runtime.delete(key);
    }
    return carried;
  }

  private projectFor(cwd: string, harness: SnapshotHarness, sessionId: string): string | null {
    if (!cwd) return null;
    const project = projectForCwd(this.projects, cwd);
    if (project) return project.projectId;
    // A chat outside every hitched folder is a COMPLETE, CORRECT chat (§4) — it
    // just has no project attachment. Logged once so it's explicable, never
    // skipped.
    const seen = `${harness}:${cwd}`;
    if (!this.loggedUnknownProjects.has(seen)) {
      this.loggedUnknownProjects.add(seen);
      this.logger.info(
        `[observer] ${harness} chat ${sessionId.slice(0, 8)} in ${cwd} maps to no hitch project — reported unattached`,
      );
    }
    return null;
  }
}

// Ranking for the cap: live chats matter most, then whatever moved most
// recently. When the cap bites we truncate the TAIL, and the snapshot says so.
function rank(chat: ObservedChat): number {
  if (chat.existence === "running") return 3;
  if (chat.existence === "pending") return 2;
  return 1;
}

function seenAt(chat: ObservedChat): number {
  const age = chat.evidence.mtimeAge;
  return typeof age === "number" ? -age : 0;
}

export type { ChatSnapshot } from "./types.js";
