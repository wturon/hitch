// Chat Inspector — the pure half. Everything here is a total function over the
// server's own rows: no fetching, no React, no clock except the one passed in.
// The Inspector is a debugging instrument (docs/chat-tracking-redesign.md §9),
// so its derivations have to be as auditable as the pipeline they explain.
//
// The one rule that shapes this file: the server owns `status`. Nothing here
// re-derives it. We render the three OBSERVED axes beside the conclusion the
// server drew from them, so a disagreement is visible rather than hidden.

export type ChatExistence = "running" | "dormant" | "pending";
export type ChatActivity = "working" | "idle" | "unknown";
export type ChatBlock = "permission" | "question";
export type ChatStatus = "busy" | "waiting_input" | "idle" | "dead";

/** The shape the Inspector actually reads — a structural subset of GET /chats. */
export interface InspectorChatLike {
  id: string;
  title: string;
  harness: string;
  sessionId: string | null;
  cwd: string | null;
  machineId: string;
  machineName?: string | null;
  projectId: string | null;
  projectName?: string | null;
  task?: { id: string; title: string } | null;
  handle: unknown;
  existence: ChatExistence | null;
  activity: ChatActivity | null;
  block: ChatBlock | null;
  status: ChatStatus;
  evidence: unknown;
  pid: number | null;
  processStartedAt: number | null;
  lastObservedAt: string | null;
  lastActivityAt: string;
}

/** The shape the Inspector reads off GET /machines. */
export interface InspectorMachineLike {
  id: string;
  name: string;
  lastSeenAt: string;
  chatSnapshotAt: string | null;
  chatWindowSince: string | null;
  chatWindowCap: number | null;
  chatWindowTruncated: boolean | null;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** ms since `iso`, or null when there's no timestamp to measure. */
export function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : now - then;
}

/**
 * One unit, always — an instrument column is scanned, not read, and "4m 12s"
 * costs two glances where "4m" costs one. Sub-second reads `0s` rather than
 * a special case, so the column never changes width class mid-tick.
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** A snapshot older than this on a live machine means the rows below are fiction. */
export const STALE_SNAPSHOT_MS = 120_000;
// The daemon re-PUTs an unchanged snapshot every 60s (ChatSnapshotSink's
// refreshMs), so anything past two of those intervals is a real gap, not a
// quiet machine.

export type SnapshotHealth = "fresh" | "stale" | "never";

export function snapshotHealth(
  machine: Pick<InspectorMachineLike, "chatSnapshotAt">,
  now: number,
): { health: SnapshotHealth; ageMs: number | null } {
  const age = ageMs(machine.chatSnapshotAt, now);
  if (age === null) return { health: "never", ageMs: null };
  return { health: age > STALE_SNAPSHOT_MS ? "stale" : "fresh", ageMs: age };
}

// ---------------------------------------------------------------------------
// Per-row derivations
// ---------------------------------------------------------------------------

/**
 * Does this row still CLAIM to exist on evidence the last tick didn't confirm?
 *
 * The precise question, not a wall-clock one: the snapshot PUT stamps every
 * chat it carries with the same `observedAt`, so a row whose `last_observed_at`
 * trails its machine's `chat_snapshot_at` was NOT in the last tick — its axes
 * describe a world that has already moved on. Falls back to wall clock for a
 * machine that has never recorded snapshot coverage.
 *
 * A row with NO existence is excluded outright. Absence is not stale evidence,
 * it is the evidence: the sweep cleared existence precisely because the machine
 * stopped seeing it, and a dead chat trailing every later tick forever would
 * drown the filter in exactly the rows it isn't looking for.
 */
export function hasStaleEvidence(
  chat: Pick<InspectorChatLike, "lastObservedAt" | "existence">,
  machine: Pick<InspectorMachineLike, "chatSnapshotAt"> | undefined,
  now: number,
): boolean {
  if (chat.existence === null) return false;
  const observed = chat.lastObservedAt ? Date.parse(chat.lastObservedAt) : null;
  if (observed === null || Number.isNaN(observed)) return true;
  const snapshot = machine?.chatSnapshotAt ? Date.parse(machine.chatSnapshotAt) : null;
  if (snapshot !== null && !Number.isNaN(snapshot)) {
    // 1s of slack: the two timestamps come from the same PUT, but a row the
    // server touched a hair later must not read as stale.
    return snapshot - observed > 1_000;
  }
  return now - observed > STALE_SNAPSHOT_MS;
}

/** A chat with no task, no project and no handle — observed, and nothing more. */
export function isUnattached(chat: InspectorChatLike): boolean {
  return !chat.task && !chat.projectId && chat.handle == null;
}

/** In the window = the last snapshot still carried it (absence clears existence). */
export function isInWindow(chat: Pick<InspectorChatLike, "existence">): boolean {
  return chat.existence !== null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const FILTERS = ["all", "live", "blocked", "unattached", "stale"] as const;
export type InspectorFilter = (typeof FILTERS)[number];

export const FILTER_LABELS: Record<InspectorFilter, string> = {
  all: "All",
  live: "Live",
  blocked: "Blocked",
  unattached: "Unattached",
  stale: "Stale evidence",
};

export function matchesFilter(
  filter: InspectorFilter,
  chat: InspectorChatLike,
  machine: InspectorMachineLike | undefined,
  now: number,
): boolean {
  switch (filter) {
    case "all":
      return true;
    // Live is the negative of the ONE terminal status, matching GET /chats?live:
    // a dormant chat is still live — it is resumable.
    case "live":
      return chat.status !== "dead";
    case "blocked":
      return chat.block !== null;
    case "unattached":
      return isUnattached(chat);
    case "stale":
      return hasStaleEvidence(chat, machine, now);
  }
}

export function filterCounts(
  chats: InspectorChatLike[],
  machinesById: Map<string, InspectorMachineLike>,
  now: number,
): Record<InspectorFilter, number> {
  const counts = { all: 0, live: 0, blocked: 0, unattached: 0, stale: 0 };
  for (const chat of chats) {
    for (const filter of FILTERS) {
      if (matchesFilter(filter, chat, machinesById.get(chat.machineId), now)) {
        counts[filter] += 1;
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface EvidenceEntry {
  key: string;
  value: string;
}

/**
 * The evidence jsonb, flattened to printable key/values. `source` is hoisted
 * first because it answers "which sensor said this" — the first question you
 * ask of any row. Everything else keeps its own order; the daemon writes the
 * blob flat and small by contract (observer/types.ts ObservationEvidence).
 */
export function evidenceEntries(evidence: unknown): EvidenceEntry[] {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return evidence === null || evidence === undefined
      ? []
      : [{ key: "evidence", value: String(evidence) }];
  }
  const record = evidence as Record<string, unknown>;
  const keys = Object.keys(record);
  const ordered = [
    ...keys.filter((k) => k === "source"),
    ...keys.filter((k) => k !== "source"),
  ];
  return ordered.map((key) => ({ key, value: printValue(record[key]) }));
}

function printValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The tail of a cwd. Paths share long, identical prefixes (~/code/…), so the
 * discriminating end is the part worth the pixels; the full path stays on the
 * title attribute. Ellipsis-truncation would show exactly the useless half.
 */
export function shortCwd(cwd: string | null, segments = 2): string {
  if (!cwd) return "no cwd";
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= segments) return cwd;
  return `…/${parts.slice(-segments).join("/")}`;
}

/** Short session id for the row's second line — enough to grep a transcript by. */
export function shortSession(sessionId: string | null): string {
  if (!sessionId) return "—";
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}
