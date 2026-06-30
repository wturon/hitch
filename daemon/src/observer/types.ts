import type {
  ChatLifecycleHarness,
  ChatLifecycleStatus,
} from "../chatLifecycleStore.js";

// The chat-state observer derives state from the machine (process table + each
// harness's own files), independent of hooks. This is the level-triggered side
// of the migration described in `.hitch/notes/chat-statuses-3-0`. The shapes
// here are the observer's output; they feed the shadow columns on `local_chats`
// and (once the flip in P2 lands) the unified `deriveChatStatus` seam.

// Existence axis — does a live process back this chat right now?
//   running  — a live harness process owns the session/thread.
//   dormant  — a transcript/rollout exists on disk, no live process; resumable.
//   gone     — we previously saw it live, now there's no process AND the log
//              looks settled. The signal that heals a "stuck in working" chat.
export type ObservedExistence = "running" | "dormant" | "gone";

// Activity axis — derived from the log tail (+ the harness's own self-report
// where it carries one). `unknown` when we can't read the log or it's
// genuinely ambiguous; callers must treat unknown conservatively (never as
// "working").
export type ObservedActivity = "working" | "idle" | "unknown";

// Which signal produced an observation — recorded for the disagreement log and
// the debug screen. needs-help is intentionally absent: it is not file-derivable
// (an open tool is indistinguishable from a permission prompt on disk), so it
// stays an event overlay that degrades to `working`/`waiting`.
export type ObservedSource =
  | "claude-pidfile" // ~/.claude/sessions/<pid>.json `status` self-report
  | "claude-transcript" // last assistant line + freshness
  | "claude-agents" // `claude agents --json`
  | "codex-rollout" // latest rollout turn + (mtime,size) freshness
  | "codex-sqlite" // state_5.sqlite catalog only (no log read)
  | "reconcile"; // liveness sweep with no fresh log read

export interface ObservationEvidence {
  // Free-form, JSON-serializable breadcrumbs for the disagreement log: the
  // pidfile status string, the last stop_reason, file (mtime,size), etc. Kept
  // small — this is debugging context, not a second source of truth.
  [key: string]: string | number | boolean | null;
}

// One derived snapshot of a chat's machine state at `observedAt`.
export interface Observation {
  harness: ChatLifecycleHarness;
  chatId: string;
  host: string;
  cwd: string;
  // Resolved from `cwd` against the known hitch projects; null when the chat
  // lives outside every hitched folder (surfaced as "unknown project").
  projectId: string | null;
  environment: string | null;
  existence: ObservedExistence;
  activity: ObservedActivity;
  pid: number | null;
  title: string | null;
  observedAt: number;
  source: ObservedSource;
  evidence: ObservationEvidence;
}

// The status an observation maps to, ignoring events. `needs-input` is never
// produced here (see ObservedSource) — it's an event-only overlay.
export type ObservedStatus = Exclude<ChatLifecycleStatus, "needs-input">;

export type { ChatLifecycleHarness, ChatLifecycleStatus };
