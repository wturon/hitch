// The ATTACHMENT layer (docs/chat-tracking-redesign.md §4).
//
// Observation answers "which chats exist and what are they doing". This layer
// answers the two OPTIONAL, independent questions bolted onto a chat:
//
//   task   — which assignment this chat serves (product truth)
//   handle — how to focus or close it (convenience)
//
// A chat with neither is a complete, correct chat. So none of this may live in
// `daemon/src/observer/`, and nothing there imports it: the observer takes an
// `AttachmentSource` — a plain data interface declared in observer/types.ts —
// and never learns that cmux, launchers or assignments exist.
//
// It does three jobs:
//
//   1. PRE-REGISTRATION. Claude pins its session id before the process starts,
//      so the moment we launch we can put the chat in the snapshot with
//      `existence: "pending"`. The server upserts on
//      (machine, harness, session), so when observation discovers the real
//      process a moment later it lands on the same row. Codex has no id to pin
//      (§ "the asymmetry" below), so nothing is pre-registered for it.
//   2. BINDING. A codex thread id first appears on a hook event. The hook
//      records the cmux surface it fired under; we join that against the
//      launch record and thereby learn which assignment the thread serves.
//   3. LINKING. The snapshot PUT returns the chat rows it upserted; we PATCH
//      the assignment's `chat_id` with the row that matches the session we
//      launched. That replaces the legacy POST /daemon/chats, which was the
//      last writer of chats outside the snapshot.
//
// THE CODEX ASYMMETRY, stated plainly: between spawn and the first prompt a
// codex assignment reads `spawning` with NO chat row at all. That is honest —
// the thread genuinely does not exist yet. The launch record on disk is what
// stops a restart in that window from double-spawning, and its TTL is what
// stops the assignment sitting in `spawning` forever.

import type { HitchClient } from "../v2/serverClient.js";
import type {
  AttachmentSource,
  ChatAttachment,
  JsonObject,
  ObservedActivity,
  ObservedChat,
  ObservedExistence,
  SnapshotHarness,
} from "../observer/types.js";
import { LaunchStore, type LaunchRecord } from "./launches.js";
import type { SpooledEvent } from "../observer/spool.js";

export interface AttachmentLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface AttachmentLayerOptions {
  client: HitchClient;
  host: string;
  logger: AttachmentLogger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam: inject a store with an explicit path. */
  launches?: LaunchStore;
}

/** One chat we launched, from our side of the glass. */
interface LaunchedChat {
  harness: SnapshotHarness;
  sessionId: string;
  launchId: string;
  cwd: string | null;
  projectId: string | null;
  title: string | null;
  task: string | null;
  handle: JsonObject | null;
  /** Set once observation has seen this session; we stop injecting it then. */
  observedAt: number | null;
  /** Injected axes. Real launches only ever inject `pending`. */
  existence: ObservedExistence;
  activity: ObservedActivity;
  /**
   * Fake-launch only: keep injecting these axes forever, because nothing on
   * this machine will ever observe a session that has no process, no transcript
   * and no thread.
   */
  simulated: boolean;
  createdAt: number;
}

interface PendingLink {
  harness: SnapshotHarness;
  sessionId: string;
  assignmentId: string;
  launchId: string;
}

/** A server chat row, in the minimal shape linking needs. */
export interface LinkableChat {
  id: string;
  harness: string;
  sessionId: string | null;
}

const key = (harness: SnapshotHarness, sessionId: string) => `${harness}:${sessionId}`;

// Hook vocabulary ("claude-code") → wire vocabulary ("claude").
const wireHarness = (harness: string): SnapshotHarness =>
  harness === "codex" ? "codex" : "claude";

export class AttachmentLayer implements AttachmentSource {
  private readonly client: HitchClient;
  private readonly host: string;
  private readonly logger: AttachmentLogger;
  private readonly now: () => number;
  readonly launches: LaunchStore;

  private readonly chats = new Map<string, LaunchedChat>();
  private readonly links = new Map<string, PendingLink>();
  // Links with a PATCH in flight. resolveLinks is driven from TWO places (the
  // snapshot PUT's echo and the reconciler's own chat read), which can overlap.
  private readonly linking = new Set<string>();

  /** Set by the wiring to nudge the reconciler when an attachment changes. */
  onChange: (reason: string) => void = () => {};

  constructor(options: AttachmentLayerOptions) {
    this.client = options.client;
    this.host = options.host;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.launches = options.launches ?? new LaunchStore({ env: options.env });
    this.recover();
  }

  // ─── the reconciler's side ────────────────────────────────────────────────

  /**
   * Record a launch BEFORE the harness starts. Durable, so a restart in the
   * spawn window neither re-spawns nor loses the assignment.
   */
  registerLaunch(input: {
    launchId: string;
    assignmentId: string;
    harness: SnapshotHarness;
    cwd: string;
    projectId: string | null;
    title: string;
  }): void {
    this.launches.record(
      {
        launchId: input.launchId,
        harness: input.harness,
        assignmentId: input.assignmentId,
        projectId: input.projectId,
        title: input.title,
        cwd: input.cwd,
      },
      this.now(),
    );
  }

  /** A launch that never got off the ground — forget it. */
  dropLaunch(launchId: string): void {
    this.launches.drop(launchId, this.now());
  }

  /** The assignment is settled; nothing more to attach. */
  forgetAssignment(assignmentId: string): void {
    for (const [k, link] of this.links) {
      if (link.assignmentId === assignmentId) this.links.delete(k);
    }
    this.launches.dropForAssignment(assignmentId, this.now());
  }

  /**
   * Assignments with a launch still in flight (recorded, not yet linked). Read
   * ONCE per reconcile pass, not once per assignment — it hits the disk.
   */
  pendingLaunches(): Set<string> {
    const out = new Set<string>();
    for (const record of this.launches.list(this.now())) {
      if (record.assignmentId && record.linkedAt === undefined) out.add(record.assignmentId);
    }
    return out;
  }

  /** Is a launch for this assignment still in flight? */
  launchPending(assignmentId: string): boolean {
    return this.pendingLaunches().has(assignmentId);
  }

  /**
   * The launcher pinned a session id up front (claude's `--session-id`, and the
   * fake launcher for both harnesses). Pre-register the chat so it appears in
   * the very next snapshot as `pending`, and queue the assignment link.
   */
  bindSession(launchId: string, sessionId: string): void {
    const now = this.now();
    this.launches.bindSession(launchId, sessionId, now);
    const record = this.launches.list(now).find((r) => r.launchId === launchId);
    if (!record) return;
    this.adopt(record, sessionId, "pending");
    this.onChange("session-bound");
  }

  // ─── the hook's side (codex) ──────────────────────────────────────────────

  /**
   * Drained spool events, straight from the observer. The ONLY thing we take
   * from them is the codex nonce→launch join; everything else about an event
   * belongs to observation, which relays them untouched.
   *
   * `event.launchId` is the HITCH_LAUNCH_ID we exported on the Codex command,
   * handed back to us by Codex's own hook process. An event without one is a
   * chat Hitch did not launch — correctly unattached, never guessed at.
   */
  onSpooledEvents(events: SpooledEvent[]): void {
    for (const event of events) {
      if (wireHarness(event.harness) !== "codex") continue;
      if (!event.launchId) continue;
      const k = key("codex", event.chatId);
      if (this.chats.has(k)) continue; // already bound — nothing to resolve

      const now = this.now();
      const claimed = this.launches.claimByLaunchId(event.launchId, event.chatId, now);
      const record = claimed ?? this.launches.forSession(event.chatId, now);
      if (!record) continue;
      // Observation will discover the thread on its own; all we add is the
      // attachment, so the chat is NOT injected as pending here.
      this.adopt(record, event.chatId, null);
      this.logger.info(
        `[hitch] attachment: codex thread ${event.chatId.slice(0, 8)} bound to ` +
          `assignment ${record.assignmentId ?? "none"} (launch ${event.launchId.slice(0, 8)})`,
      );
      this.onChange("codex-bound");
    }
  }

  // ─── the observer's side (AttachmentSource) ───────────────────────────────

  /** Chats we launched that observation can't see yet. */
  injected(now: number): ObservedChat[] {
    const out: ObservedChat[] = [];
    // One read of the launch file per tick, not one per chat.
    const live = this.liveLaunchIds(now);
    for (const chat of this.chats.values()) {
      if (!chat.simulated && chat.observedAt !== null) continue;
      if (!chat.simulated && !live.has(chat.launchId)) continue;
      out.push({
        harness: chat.harness,
        sessionId: chat.sessionId,
        cwd: chat.cwd,
        process: null,
        existence: chat.existence,
        activity: chat.activity,
        source: chat.simulated ? "fake-launch" : "launch-pending",
        evidence: {
          launchId: chat.launchId,
          ageMs: now - chat.createdAt,
          ...(chat.simulated ? { simulated: true } : {}),
        },
        projectId: chat.projectId,
        task: chat.task,
        handle: chat.handle,
        ...(chat.title ? { title: chat.title } : {}),
      });
    }
    return out;
  }

  /** Observation has taken this session over; stop pre-registering it. */
  observed(harness: SnapshotHarness, sessionId: string): void {
    const chat = this.chats.get(key(harness, sessionId));
    if (!chat || chat.simulated || chat.observedAt !== null) return;
    chat.observedAt = this.now();
  }

  /** Attachment fields for a chat, if we launched it. */
  lookup(harness: SnapshotHarness, sessionId: string): ChatAttachment | null {
    const chat = this.chats.get(key(harness, sessionId));
    if (!chat) return null;
    return {
      task: chat.task,
      handle: chat.handle,
      ...(chat.title ? { title: chat.title } : {}),
      projectId: chat.projectId,
    };
  }

  // ─── linking ──────────────────────────────────────────────────────────────

  /**
   * Resolve outstanding assignment→chat links against server chat rows. Called
   * with the rows the snapshot PUT just upserted AND with the reconciler's own
   * GET /daemon/chats, so a link never waits on a single code path.
   */
  async resolveLinks(rows: LinkableChat[]): Promise<void> {
    if (this.links.size === 0 || rows.length === 0) return;
    const byKey = new Map<string, string>();
    for (const row of rows) {
      if (row.sessionId) byKey.set(key(wireHarness(row.harness), row.sessionId), row.id);
    }
    for (const [k, link] of [...this.links]) {
      const chatId = byKey.get(k);
      if (!chatId || this.linking.has(k)) continue;
      this.linking.add(k);
      let ok = false;
      try {
        ok = await this.patchAssignmentChat(link.assignmentId, chatId);
      } finally {
        this.linking.delete(k);
      }
      if (!ok) continue; // keep the request; the next tick retries
      this.links.delete(k);
      this.launches.markLinked(link.launchId, this.now());
      this.logger.info(
        `[hitch] attachment: assignment ${link.assignmentId} linked to chat ${chatId}`,
      );
      this.onChange("chat-linked");
    }
  }

  /** Drop expired launch records. Returns the assignments they never bound. */
  sweep(): string[] {
    const now = this.now();
    const expired = this.launches.pruneExpired(now);
    // Bound the live set: once a launch record ages out, the attachment it
    // carried is already ON the server row (the snapshot wrote it), and the
    // server never blanks a field a later snapshot omits — so we can forget it
    // here rather than decorating the same chat for the daemon's lifetime.
    // Simulated (fake-launch) chats are exempt: nothing else will ever report
    // them, so dropping one would silently end a test's chat.
    const live = this.liveLaunchIds(now);
    for (const [k, chat] of this.chats) {
      if (chat.simulated) continue;
      if (!live.has(chat.launchId)) this.chats.delete(k);
    }
    const orphaned: string[] = [];
    for (const record of expired) {
      if (!record.assignmentId || record.linkedAt !== undefined) continue;
      this.links.delete(key(record.harness ?? "claude", record.sessionId ?? ""));
      orphaned.push(record.assignmentId);
    }
    return orphaned;
  }

  // ─── fake-launch seam (TEST ONLY) ─────────────────────────────────────────

  /**
   * Drive a chat's axes directly. HITCH_FAKE_LAUNCH only: a fake session has no
   * process, no transcript and no thread, so observation can never see it —
   * which is exactly what makes the scripted loop heal-proof. The axes go on
   * the wire through the same snapshot everything else does.
   */
  simulate(input: {
    harness: SnapshotHarness;
    sessionId: string;
    existence?: ObservedExistence;
    activity?: ObservedActivity;
  }): boolean {
    const chat = this.chats.get(key(input.harness, input.sessionId));
    if (!chat) return false;
    chat.simulated = true;
    if (input.existence) chat.existence = input.existence;
    if (input.activity) chat.activity = input.activity;
    this.onChange("simulate");
    return true;
  }

  /** Stop simulating (and stop injecting) a fake chat entirely. */
  release(harness: SnapshotHarness, sessionId: string): void {
    this.chats.delete(key(harness, sessionId));
  }

  // ─── internals ────────────────────────────────────────────────────────────

  // Take a launch record + a now-known session id into the live attachment set,
  // and queue the assignment link. `existence` is the axis to inject until
  // observation takes over — null means "don't inject, just decorate".
  private adopt(
    record: LaunchRecord,
    sessionId: string,
    existence: ObservedExistence | null,
  ): void {
    const harness = record.harness ?? "claude";
    const k = key(harness, sessionId);
    const existing = this.chats.get(k);
    const chat: LaunchedChat = existing ?? {
      harness,
      sessionId,
      launchId: record.launchId,
      cwd: record.cwd ?? null,
      projectId: record.projectId ?? null,
      title: record.title ?? null,
      task: record.assignmentId ?? null,
      handle: this.handleFor(record, sessionId),
      observedAt: existence === null ? this.now() : null,
      existence: existence ?? "running",
      activity: "unknown",
      simulated: false,
      createdAt: record.createdAt,
    };
    this.chats.set(k, chat);
    if (record.assignmentId && record.linkedAt === undefined) {
      this.links.set(k, {
        harness,
        sessionId,
        assignmentId: record.assignmentId,
        launchId: record.launchId,
      });
    }
  }

  // Attachment 2: how to get back to this chat. Same field names the old
  // `cmux_ref` used, because focus/close read them.
  private handleFor(record: LaunchRecord, sessionId: string): JsonObject {
    return {
      kind: "cmux",
      sessionId,
      launchId: record.launchId,
      cwd: record.cwd ?? null,
      host: this.host,
      environment: "cmux",
      resumeKind: "open-chat-command",
    };
  }

  private liveLaunchIds(now: number): Set<string> {
    return new Set(this.launches.list(now).map((r) => r.launchId));
  }

  // Rebuild the live set from disk at startup: a daemon restarted mid-launch
  // must still pre-register, still link, and still not re-spawn.
  private recover(): void {
    const now = this.now();
    for (const record of this.launches.list(now)) {
      if (!record.sessionId) continue;
      this.adopt(record, record.sessionId, record.linkedAt === undefined ? "pending" : null);
    }
  }

  private async patchAssignmentChat(assignmentId: string, chatId: string): Promise<boolean> {
    try {
      const res = await this.client.daemon.assignments[":id"].$patch({
        param: { id: assignmentId },
        json: { chatId },
      });
      if (res.ok) return true;
      this.logger.error?.(
        `[hitch] attachment: linking assignment ${assignmentId} → chat ${chatId} failed (${res.status})`,
      );
      return false;
    } catch (error) {
      this.logger.error?.(`[hitch] attachment: link error: ${String(error)}`);
      return false;
    }
  }
}
