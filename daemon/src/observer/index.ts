import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import {
  DaemonLifecycleProducer,
} from "../chatLifecycleProducers.js";
import type {
  ChatLifecycleHarness,
  ChatLifecycleStore,
  LocalChatRow,
  ObservationRecord,
} from "../chatLifecycleStore.js";
import {
  activityFromPidfileStatus,
  claudeHome,
  deriveClaudeTranscriptActivity,
  discoverClaudeSessions,
  findClaudeTranscript,
  sessionsDir,
  type ClaudeSession,
} from "./claudeObserver.js";
import {
  codexHome,
  deriveCodexRolloutActivity,
  readCodexThreads,
  type CodexThread,
} from "./codexObserver.js";
import { deriveStatusFromObservation, statusesDisagree } from "./derive.js";
import {
  codexResumeThreadId,
  codexTuiProcesses,
  snapshotProcesses,
  type ProcessInfo,
} from "./liveness.js";
import { projectForCwd, type ObserverProject } from "./projects.js";
import { readLatestTail, type TailCursor } from "./tail.js";
import type {
  Observation,
  ObservedActivity,
  ObservedExistence,
} from "./types.js";

export interface ChatStateObserverOptions {
  store: ChatLifecycleStore;
  // Every hitched project on this machine: used to map a chat's cwd to a
  // projectId and to address the heal producer's events.
  projects: ObserverProject[];
  host: string;
  logger: { info: (m: string) => void; error?: (m: string) => void };
  now?: () => number;
}

// Trailing settle before we declare a file-derived `working` chat `idle` — the
// asymmetric-debounce floor (claude-control uses ~3s in the wild). The leading
// edge (any new byte / a "busy" self-report) flips to working instantly.
const SETTLE_MS = 3_000;
// Reconcile cadence: tight while a chat is active, backing off when idle. Jitter
// avoids thundering herds across many daemons. Reset to the active cadence on
// any file-watch event.
const ACTIVE_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 30_000;
// When a tracked chat looks dead but isn't yet confirmed, re-check soon so the
// heal lands in a few seconds rather than after a full idle interval.
const CONFIRM_INTERVAL_MS = 3_000;
// Coalesce bursts of file-watch events (a turn appends many lines) into one
// reconcile.
const WATCH_DEBOUNCE_MS = 250;
// A tracked-live chat must miss the live set this many consecutive reconciles
// before we heal it — guards against a transient discovery race (a pidfile
// momentarily unreadable, `claude agents` timing out).
const DEAD_MISS_THRESHOLD = 2;
// Don't read a chat's tail more than this far back on a cold cursor.
const CODEX_THREAD_LIMIT = 200;
// A Codex thread counts as possibly-running only if its rollout moved this
// recently AND a live `codex` process shares its cwd.
const CODEX_RUNNING_FRESH_MS = 60_000;

interface ChatRuntime {
  lastWorkingAt: number;
  deadMisses: number;
}

// Maps a Claude pidfile `entrypoint` to hitch's `environment` vocabulary. Only
// the editor entrypoints carry over; cli/cmux aren't distinguishable from the
// pidfile (cmux doesn't change the process name), so we leave those null and
// let any existing row's environment win via COALESCE.
function claudeEnvironment(entrypoint: string | null): string | null {
  if (entrypoint === "claude-vscode") return "vscode";
  return null;
}

// The level-triggered chat-state observer. Derives chat state from the machine
// (process table + each harness's own files) and writes it to the shadow
// columns on `local_chats`, running in parallel with the hook-derived status so
// we can log disagreements and tune before flipping (P2). The one wired
// behavior is the Claude dead-process heal — see `healDeadClaude`.
export class ChatStateObserver {
  private readonly store: ChatLifecycleStore;
  private readonly projects: ObserverProject[];
  private readonly host: string;
  private readonly logger: ChatStateObserverOptions["logger"];
  private readonly now: () => number;
  private readonly runtime = new Map<string, ChatRuntime>();
  private readonly producers = new Map<string, DaemonLifecycleProducer>();
  private readonly loggedUnknownProjects = new Set<string>();
  private readonly loggedDisagreements = new Map<string, string>();

  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(options: ChatStateObserverOptions) {
    this.store = options.store;
    this.projects = options.projects;
    this.host = options.host;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.startWatchers();
    void this.reconcile("startup");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    await Promise.all(this.watchers.map((w) => w.close().catch(() => {})));
    this.watchers = [];
  }

  // --- watchers (fast path) --------------------------------------------------

  private startWatchers(): void {
    // Watch parent directories, not files: atomic-rename/truncation/inode
    // changes break file-level watches. depth keeps us off the deep transcript
    // sub-trees. Errors are logged, never thrown — a missing dir just means that
    // harness isn't in use yet; the reconcile floor still covers correctness if
    // a watcher dies (e.g. inotify ENOSPC on Linux).
    const claudeProjects = join(claudeHome(), "projects");
    const codexSessions = join(codexHome(), "sessions");
    const targets: Array<{ path: string; depth: number }> = [
      { path: claudeProjects, depth: 1 },
      { path: sessionsDir(), depth: 0 },
      { path: codexSessions, depth: 4 },
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
            this.logger.error?.(
              `[observer] watcher error on ${target.path}: ${String(err)}`,
            ),
          );
        this.watchers.push(watcher);
      } catch (err) {
        this.logger.error?.(
          `[observer] failed to watch ${target.path}: ${String(err)}`,
        );
      }
    }
  }

  private onWatchEvent(): void {
    if (this.stopped) return;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      void this.reconcile("watch");
    }, WATCH_DEBOUNCE_MS);
  }

  // --- reconcile floor -------------------------------------------------------

  private scheduleNext(anyWorking: boolean, pendingHeal: boolean): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    let base = anyWorking ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    if (pendingHeal) base = Math.min(base, CONFIRM_INTERVAL_MS);
    // ±20% jitter on the longer intervals so many daemons don't reconcile in
    // lockstep; none on the tight active cadence.
    const jitter =
      base > ACTIVE_INTERVAL_MS ? base * 0.2 * (Math.random() - 0.5) : 0;
    this.timer = setTimeout(
      () => void this.reconcile("interval"),
      Math.max(ACTIVE_INTERVAL_MS, Math.round(base + jitter)),
    );
  }

  private async reconcile(reason: string): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    let anyWorking = false;
    let pendingHeal = false;
    try {
      const processes = await snapshotProcesses();
      const now = this.now();

      const sessions = await discoverClaudeSessions(processes);
      const liveClaudeIds = new Set<string>();
      for (const session of sessions) {
        if (!session.alive) continue;
        liveClaudeIds.add(session.sessionId);
        const obs = this.observeClaude(session, now);
        if (!obs) continue;
        if (obs.activity === "working") anyWorking = true;
        this.record(obs);
      }
      // Only heal when the live snapshot is trustworthy. An empty `ps` means the
      // snapshot itself failed — every tracked chat would look dead and we'd mass
      // false-heal live sessions. Skip the heal that tick rather than risk it.
      if (processes.length > 0) {
        pendingHeal = this.healDeadClaude(liveClaudeIds);
      }

      const threads = readCodexThreads(CODEX_THREAD_LIMIT);
      const codexTui = codexTuiProcesses(processes);
      for (const thread of threads) {
        const obs = this.observeCodex(thread, codexTui, now);
        if (!obs) continue;
        if (obs.activity === "working") anyWorking = true;
        this.record(obs);
      }
    } catch (err) {
      this.logger.error?.(`[observer] reconcile failed (${reason}): ${String(err)}`);
    } finally {
      this.running = false;
      this.scheduleNext(anyWorking, pendingHeal);
      if (this.rerun) {
        this.rerun = false;
        queueMicrotask(() => void this.reconcile("rerun"));
      }
    }
  }

  // --- per-harness observation -----------------------------------------------

  private observeClaude(
    session: ClaudeSession,
    now: number,
  ): Observation | null {
    const project = this.resolveProject(session.cwd, "claude-code", session.sessionId);
    if (!project) return null; // unknown project — don't tail unrelated transcripts
    // Glob the transcript by session id — never reconstruct it from cwd (the
    // munge is lossy). null when persistence is off or it ran on another host.
    const transcriptPath = findClaudeTranscript(session.sessionId);

    // Prefer the harness's own self-report; fall back to the transcript tail
    // (vscode reports null). Either way feed it through the asymmetric debounce.
    let rawActivity = activityFromPidfileStatus(session.status);
    const source: Observation["source"] =
      rawActivity === "unknown" ? "claude-transcript" : "claude-pidfile";
    const evidence: Observation["evidence"] = {
      pidfileStatus: session.status,
      entrypoint: session.entrypoint,
      pid: session.pid,
    };

    // Level-triggered: re-derive from the *current* tail every reconcile, so a
    // long silent tool stays `working` until the transcript gains a terminal
    // marker — not just until a settle timer fires.
    const fileChanged = transcriptPath
      ? this.tail("claude-code", session.sessionId, transcriptPath, (lines) => {
          if (rawActivity === "unknown") {
            const derived = deriveClaudeTranscriptActivity(lines);
            rawActivity = derived.activity;
            evidence.lastStopReason = derived.lastStopReason;
          }
        })
      : false;

    const activity = this.debounceActivity(
      "claude-code",
      session.sessionId,
      rawActivity,
      fileChanged,
      now,
    );

    return {
      harness: "claude-code",
      chatId: session.sessionId,
      host: this.host,
      cwd: session.cwd,
      projectId: project.projectId,
      environment: claudeEnvironment(session.entrypoint),
      existence: "running",
      activity,
      pid: session.pid,
      title: session.name,
      observedAt: now,
      source,
      evidence,
    };
  }

  private observeCodex(
    thread: CodexThread,
    codexTui: ProcessInfo[],
    now: number,
  ): Observation | null {
    if (thread.archived) return null;
    const project = this.resolveProject(thread.cwd, "codex", thread.id);
    if (!project) return null; // unknown project — don't tail unrelated rollouts

    const resumeMatch = codexTui.some(
      (p) => codexResumeThreadId(p.command) === thread.id.toLowerCase(),
    );
    const fresh = now - thread.updatedAtMs < CODEX_RUNNING_FRESH_MS;
    const cwdMatch = codexTui.some((p) => p.command.includes(thread.cwd));
    const existence: ObservedExistence =
      resumeMatch || (fresh && cwdMatch) ? "running" : "dormant";

    const evidence: Observation["evidence"] = {
      resumeMatch,
      updatedAtMs: thread.updatedAtMs,
      source: thread.source,
    };

    // Only tail plausibly-running threads. A dormant thread's status is `idle`
    // regardless of its last turn, so re-reading its rollout every reconcile is
    // wasted I/O — without this gate a heavy user pays ~200×128KB reads per tick
    // for the whole recent-thread catalog. I/O now scales with active chats.
    let rawActivity: ObservedActivity = "unknown";
    let fileChanged = false;
    if (existence === "running") {
      fileChanged = this.tail("codex", thread.id, thread.rolloutPath, (lines) => {
        const derived = deriveCodexRolloutActivity(lines);
        rawActivity = derived.activity;
        evidence.marker = derived.marker;
      });
    }

    const activity =
      existence === "running"
        ? this.debounceActivity("codex", thread.id, rawActivity, fileChanged, now)
        : "idle";

    return {
      harness: "codex",
      chatId: thread.id,
      host: this.host,
      cwd: thread.cwd,
      projectId: project.projectId,
      environment: thread.source === "vscode" ? "vscode" : null,
      existence,
      activity,
      pid: null,
      title: thread.title,
      observedAt: now,
      source: fileChanged || rawActivity !== "unknown" ? "codex-rollout" : "codex-sqlite",
      evidence,
    };
  }

  // --- shared helpers --------------------------------------------------------

  // Level-triggered tail: re-read the *current* bounded tail window every tick
  // and hand its complete lines to `consume`, so derivation reflects the present
  // latest-turn state rather than only newly-appended bytes. The persisted
  // cursor (size/mtime/identity) is used only to report whether the file changed
  // since last tick — the leading-edge "working" trigger. Returns that flag.
  private tail(
    harness: ChatLifecycleHarness,
    chatId: string,
    path: string,
    consume: (lines: string[]) => void,
  ): boolean {
    const prior = this.store.getObservedFile(harness, chatId, this.host);
    const priorCursor: TailCursor | null = prior
      ? {
          dev: prior.fileDev,
          ino: prior.fileIno,
          offset: prior.offset,
          size: prior.fileSize,
          mtimeMs: prior.fileMtimeMs,
        }
      : null;
    const result = readLatestTail(path, priorCursor);
    if (!result) return false;
    if (result.lines.length > 0) consume(result.lines);
    this.store.setObservedFile({
      harness,
      chatId,
      host: this.host,
      logPath: path,
      offset: result.cursor.offset,
      fileDev: result.cursor.dev,
      fileIno: result.cursor.ino,
      fileSize: result.cursor.size,
      fileMtimeMs: result.cursor.mtimeMs,
      updatedAt: this.now(),
    });
    return result.changed;
  }

  // Asymmetric debounce: working is a leading edge (instant); idle requires a
  // trailing settle so we don't flap between a turn's tool calls.
  private debounceActivity(
    harness: ChatLifecycleHarness,
    chatId: string,
    raw: ObservedActivity,
    fileChanged: boolean,
    now: number,
  ): ObservedActivity {
    const key = `${harness}:${chatId}`;
    const rt = this.runtime.get(key) ?? { lastWorkingAt: 0, deadMisses: 0 };
    const workingSignal = raw === "working" || fileChanged;
    if (workingSignal) {
      rt.lastWorkingAt = now;
      this.runtime.set(key, rt);
      return "working";
    }
    this.runtime.set(key, rt);
    if (now - rt.lastWorkingAt < SETTLE_MS) return "working";
    return raw; // "idle" or "unknown"
  }

  private record(obs: Observation): void {
    if (obs.projectId === null) return; // unknown project — already logged
    const status = deriveStatusFromObservation(obs);
    const record: ObservationRecord = {
      harness: obs.harness,
      chatId: obs.chatId,
      host: obs.host,
      cwd: obs.cwd,
      projectId: obs.projectId,
      environment: obs.environment,
      existence: obs.existence,
      activity: obs.activity,
      source: obs.source,
      status,
      title: obs.title,
      observedAt: obs.observedAt,
      evidence: obs.evidence,
      endedAt: obs.existence === "gone" ? obs.observedAt : null,
    };
    // Only running chats may create a new registry row (wide discovery);
    // dormant/gone observations just refresh chats hitch already tracks.
    this.store.recordObservation(record, {
      createIfMissing: obs.existence === "running",
    });
    this.logDisagreement(obs, status);
  }

  // Log when the observation contradicts hitch's live status — the data that
  // tells us whether the observer is ready to go primary (P2). Only logs the
  // transition (not every tick) to keep the signal readable.
  private logDisagreement(obs: Observation, observedStatus: string): void {
    const localKey = `chat:${obs.harness}:${obs.host}:${obs.chatId}`;
    const existing = this.store.getLocalChat(localKey);
    if (!existing || existing.observerCreated) return;
    if (!statusesDisagree(existing.status, obs)) {
      this.loggedDisagreements.delete(localKey);
      return;
    }
    const signature = `${existing.status}→${observedStatus}`;
    if (this.loggedDisagreements.get(localKey) === signature) return;
    this.loggedDisagreements.set(localKey, signature);
    this.logger.info(
      `[observer] disagreement ${obs.harness} ${obs.chatId.slice(0, 8)}: ` +
        `hook=${existing.status} observed=${observedStatus} ` +
        `(${obs.existence}/${obs.activity}, ${obs.source})`,
    );
  }

  // --- dead-process heal (the wired behavior) --------------------------------

  // The reconcile floor's correctness layer for Claude: a chat hitch tracks as
  // live whose session is absent from the discovered live set is, after a
  // confirming miss, declared ended — converting "stuck in working forever" into
  // "≤1 reconcile stale". Emits the same `session.ended` event the old chat-pid
  // reconcile did, so the existing reducer/projection path settles it (and the
  // deterministic eventId dedups with that path). Returns true while any
  // candidate is mid-confirmation, so the caller tightens the cadence.
  private healDeadClaude(liveClaudeIds: Set<string>): boolean {
    let pending = false;
    const candidates = this.store.listLiveTrackedChats("claude-code", this.host);
    const seen = new Set<string>();
    for (const chat of candidates) {
      if (!chat.chatId) continue;
      seen.add(chat.chatId);
      const key = `claude-code:${chat.chatId}`;
      const rt = this.runtime.get(key) ?? { lastWorkingAt: 0, deadMisses: 0 };
      if (liveClaudeIds.has(chat.chatId)) {
        rt.deadMisses = 0;
        this.runtime.set(key, rt);
        continue;
      }
      // Absence is only proof of death for a *persisted* session: if its
      // transcript isn't on disk we can't observe it (--no-session-persistence,
      // a relocated CLAUDE_CONFIG_DIR), so we never heal it — leave it to the
      // hooks. Globbed by session id (not the lossy cwd munge) so the guard
      // checks the real path. A normal crashed/stale chat has a transcript and heals.
      if (!findClaudeTranscript(chat.chatId)) {
        rt.deadMisses = 0;
        this.runtime.set(key, rt);
        continue;
      }
      rt.deadMisses += 1;
      this.runtime.set(key, rt);
      if (rt.deadMisses < DEAD_MISS_THRESHOLD) {
        pending = true; // confirm on the next (tightened) tick
        continue;
      }
      this.healChat(chat);
      rt.deadMisses = 0;
      this.runtime.set(key, rt);
    }
    // Drop runtime entries for chats no longer tracked-live (keeps the map small).
    for (const key of this.runtime.keys()) {
      if (key.startsWith("claude-code:") && !seen.has(key.slice("claude-code:".length))) {
        const rt = this.runtime.get(key);
        if (rt && rt.deadMisses > 0) rt.deadMisses = 0;
      }
    }
    return pending;
  }

  private healChat(chat: LocalChatRow): void {
    if (!chat.chatId || !chat.projectId) return;
    const producer = this.producerFor(chat.projectId);
    if (!producer) return;
    try {
      producer.sessionEnded({
        harness: "claude-code",
        environment: chat.environment,
        cwd: chat.cwd || this.projectLocalPath(chat.projectId) || "",
        linkedPath: chat.linkedPath,
        chatId: chat.chatId,
        pid: null,
      });
      this.logger.info(
        `[observer] healed stuck claude chat ${chat.chatId.slice(0, 8)} ` +
          `(${chat.status} → ended; no live process)`,
      );
    } catch (err) {
      this.logger.error?.(
        `[observer] failed to heal chat ${chat.chatId}: ${String(err)}`,
      );
    }
  }

  // --- project + producer plumbing -------------------------------------------

  private resolveProject(
    cwd: string,
    harness: ChatLifecycleHarness,
    chatId: string,
  ): ObserverProject | null {
    const project = projectForCwd(this.projects, cwd);
    if (!project) {
      const seen = `${harness}:${cwd}`;
      if (!this.loggedUnknownProjects.has(seen)) {
        this.loggedUnknownProjects.add(seen);
        this.logger.info(
          `[observer] ${harness} chat ${chatId.slice(0, 8)} in ${cwd} maps to no hitch project — skipping`,
        );
      }
    }
    return project;
  }

  private projectLocalPath(projectId: string): string | null {
    return this.projects.find((p) => p.projectId === projectId)?.localPath ?? null;
  }

  private producerFor(projectId: string): DaemonLifecycleProducer | null {
    const existing = this.producers.get(projectId);
    if (existing) return existing;
    const localPath = this.projectLocalPath(projectId);
    if (!localPath) return null;
    const producer = new DaemonLifecycleProducer({
      store: this.store,
      projectId,
      projectLocalPath: localPath,
      host: this.host,
      now: this.now,
    });
    this.producers.set(projectId, producer);
    return producer;
  }
}
