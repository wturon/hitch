// The observation vocabulary — three axes, one owner each
// (docs/chat-tracking-redesign.md §3).
//
// The daemon REPORTS these; it never decides a status. `status = f(existence,
// activity, block)` is a pure function on the server (server/src/chatStatus.ts).
//
// This layer is environment-blind (§4): nothing here knows about cmux,
// terminals, tabs, editors, tasks, focus or close. It must compile with zero
// imports from `daemon/src/launchers/` or `daemon/src/cmux.ts`.

// The server's harness enum — the wire vocabulary, so nothing has to translate
// between "claude-code" and "claude" downstream of observation.
export type SnapshotHarness = "claude" | "codex";

// Existence — does a live process back this chat right now? Owned by the
// machine (process table, keyed by (pid, start-time)). Events may NEVER write
// it.
//   running  — a live harness process owns this session.
//   dormant  — its transcript moved inside the recency window, no live process;
//              resumable, and idle by definition.
//   pending  — Hitch launched it and it hasn't bound yet. Not produced by
//              observation (the launcher owns it) — declared here because the
//              wire carries it.
export type ObservedExistence = "running" | "dormant" | "pending";

// Activity — owned by the machine: the harness's own self-report where it has
// one, else a transcript (mtime, size) delta with a settle timer. `unknown`
// resolves to idle downstream, NEVER working — idle beats guessing working.
export type ObservedActivity = "working" | "idle" | "unknown";

// Block — the ONLY axis hooks own. Never outlives the process that raised it.
export type ObservedBlock = "permission" | "question";

// What produced an observation. Kept as evidence on the server row so the Chat
// Inspector can explain a status without a second data path.
export type ObservedSource =
  | "claude-pidfile" // ~/.claude/sessions/<pid>.json `status` self-report
  | "claude-transcript" // last assistant line + freshness (vscode has no status)
  | "claude-agents" // `claude agents --json` — FALLBACK ONLY, never per tick
  | "claude-dormant" // transcript inside the window, no live process
  | "codex-rollout" // latest rollout turn + (mtime,size) freshness
  | "codex-sqlite" // state_5.sqlite catalog only (no log read)
  | "carry-over" // held one tick by the 2-miss debounce
  | "launch-pending" // pre-registered by the launcher, not yet discovered
  | "fake-launch"; // HITCH_FAKE_LAUNCH scripted axes (test-only)

// JSON, spelled out: the snapshot body is validated by zod on the server, and
// the typed hono client insists the payload actually be JSON-shaped.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

// Free-form breadcrumbs behind an observation — the pidfile status, the last
// stop_reason, file (mtime, size), cursor offsets. Kept small and FLAT: this is
// debugging context, never a second source of truth.
export interface ObservationEvidence {
  [key: string]: string | number | boolean | null;
}

// Process identity, not just a pid: (pid, start-time) so PID reuse can't alias
// two chats onto one row.
export interface ObservedProcess {
  pid: number;
  /** Kernel/self-reported start time as epoch ms; null when unparseable. */
  startedAt: number | null;
}

// One chat as it goes on the wire. Mirrors the server's `chatSnapshotChat`
// validator (server/src/validation.ts) field for field.
export interface ObservedChat {
  harness: SnapshotHarness;
  sessionId: string;
  cwd: string | null;
  process: ObservedProcess | null;
  existence: ObservedExistence;
  activity: ObservedActivity;
  /** Omitted when the daemon has no belief; null explicitly means "not blocked". */
  block?: ObservedBlock | null;
  source: ObservedSource;
  evidence: ObservationEvidence;
  /** Attachment: direct project id, resolved from cwd. Null for chats outside every project. */
  projectId: string | null;
  /** Attachment 1 (§4): the assignment this chat serves. Null for found chats. */
  task?: string | null;
  /** Attachment 2 (§4): how to focus/close it. Always nullable. */
  handle?: JsonObject | null;
  title?: string;
}

// ─── the attachment seam ─────────────────────────────────────────────────────
//
// Observation is blind to launches, cmux, tasks and focus (§4), but the chats
// Hitch itself started still have to reach the snapshot with their attachments
// on. So the observer takes this PLAIN DATA interface and calls it; the thing
// that implements it (daemon/src/attachment/) knows about launchers, and the
// observer never imports it. That is the whole trick, and the reason the
// boundary can be checked mechanically.

export interface ChatAttachment {
  /** Assignment id, or null for a chat no assignment owns. */
  task?: string | null;
  handle?: JsonObject | null;
  title?: string;
  projectId?: string | null;
}

export interface AttachmentSource {
  /** Chats the launcher registered that observation cannot see yet. */
  injected: (now: number) => ObservedChat[];
  /** "Observation now owns this session" — stop injecting it. */
  observed: (harness: SnapshotHarness, sessionId: string) => void;
  /** Attachment fields for an observed chat, if we launched it. */
  lookup: (harness: SnapshotHarness, sessionId: string) => ChatAttachment | null;
}

export interface SnapshotWindow {
  /** ISO — nothing older than this was considered. */
  since: string;
  cap: number;
  /** Coverage was incomplete; the server SKIPS its death sweep entirely. */
  truncated: boolean;
}

// A relayed hook event, verbatim. The server stores these on the chat as the
// "why" behind a status.
export interface SnapshotEvent {
  sessionId: string;
  harness: SnapshotHarness;
  kind: string;
  /** ISO */
  at: string;
  payload?: JsonObject;
}

// The whole working set, every tick (§7).
export interface ChatSnapshot {
  /** ISO */
  observedAt: string;
  window: SnapshotWindow;
  chats: ObservedChat[];
  events: SnapshotEvent[];
}
