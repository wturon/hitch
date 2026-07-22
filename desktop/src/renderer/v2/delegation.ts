// Pure delegation logic for the V2 delegate bar (M4 PR 5, option L). No React,
// no HTTP, no DOM beyond a guarded localStorage read — everything here is
// unit-testable in isolation, exactly like todoGroups/tagFilter. The bar's
// three states, the observed-state → chip mapping, machine staleness, and the
// machine-facing prompt preamble all derive from these functions.
//
// Harness note: the V2 server enum is `claude | codex` (schema.ts), NOT V1's
// `claude-code | codex`. The delegate bar speaks the server's language; the V1
// Harness type and its model/effort catalog stay out of this path (V2
// assignments carry only a harness — the daemon owns model/effort at spawn).

// The server harness enum (mirror of pgEnum("harness", ...)). Kept as a local
// literal so this module has no server-package import in its type surface.
export type ServerHarness = "claude" | "codex";
export const SERVER_HARNESSES: readonly ServerHarness[] = ["claude", "codex"];

export function serverHarnessLabel(harness: ServerHarness): string {
  return harness === "codex" ? "Codex" : "Claude Code";
}

// The daemon-written lifecycle of an assignment (mirror of
// pgEnum("assignment_observed_state", ...)).
export type ObservedState =
  | "pending"
  | "spawning"
  | "running"
  | "waiting_input"
  | "done"
  | "dead";

// The three shapes the bar renders (see DelegateBar):
//   compose      — no assignment yet; pick agent/machine/prompt and delegate.
//   active       — a live assignment (latest, observed_state ∉ {done, dead}).
//   re-delegate  — the latest assignment finished (done|dead); show the outcome
//                  subtly and offer compose again. History is preserved
//                  server-side (assignments are append-only).
export type BarState = "compose" | "active" | "re-delegate";

// The minimal assignment shape the derivations need — a structural subset of
// what GET /assignments returns. createdAt crosses the wire as an ISO string;
// we parse it to an epoch and never trust lexicographic order.
export interface AssignmentLike {
  createdAt: string | Date;
  observedState: ObservedState;
}

function toEpoch(value: string | Date): number {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

// The latest assignment by created_at (the server lists ascending, but we don't
// depend on order). Ties keep the LAST occurrence in input order, so a server
// list ordered by createdAt yields the newest row — matching the daemon, which
// only ever acts on the most-recently-created assignment for a task.
export function selectLatestAssignment<T extends AssignmentLike>(
  assignments: readonly T[] | undefined,
): T | null {
  if (!assignments || assignments.length === 0) return null;
  let latest = assignments[0];
  let latestEpoch = toEpoch(latest.createdAt);
  for (let i = 1; i < assignments.length; i++) {
    const epoch = toEpoch(assignments[i].createdAt);
    // >= so an equal-timestamp later element wins (stable "last of the ties").
    if (epoch >= latestEpoch) {
      latest = assignments[i];
      latestEpoch = epoch;
    }
  }
  return latest;
}

// done/dead are terminal — the latest assignment in one of those states drops
// the bar back to re-delegate. Everything else (incl. no assignment) is
// covered explicitly.
export function deriveBarState(latest: AssignmentLike | null): BarState {
  if (!latest) return "compose";
  if (latest.observedState === "done" || latest.observedState === "dead") {
    return "re-delegate";
  }
  return "active";
}

// The visual tone of a status chip. Monochrome doctrine: only "needs-you" earns
// color (the existing amber NEEDS-YOU treatment); every other state stays
// neutral. done/dead carry their own quiet tone for the re-delegate outcome
// line.
export type ChipTone = "spawning" | "working" | "needs-you" | "done" | "dead";

export interface ChipInfo {
  label: string;
  tone: ChipTone;
}

// observed_state → chip. pending and spawning collapse into one "Spawning…"
// presentation (the daemon claims a spawn before it launches). done/dead are
// terminal and get their own labels for the re-delegate outcome line.
export function observedStateChip(state: ObservedState): ChipInfo {
  switch (state) {
    case "pending":
    case "spawning":
      return { label: "Spawning…", tone: "spawning" };
    case "running":
      return { label: "Working", tone: "working" };
    case "waiting_input":
      return { label: "Needs you", tone: "needs-you" };
    case "done":
      return { label: "Done", tone: "done" };
    case "dead":
      return { label: "Failed", tone: "dead" };
  }
}

// ─── Machines ───────────────────────────────────────────────────────────────

// A machine is stale once its heartbeat is older than this — the daemon ticks
// every ~30s, so 90s tolerates two missed beats before we call it offline.
export const MACHINE_STALE_MS = 90_000;

export interface MachineLike {
  id: string;
  name: string;
  lastSeenAt: string | Date;
}

export function isMachineStale(
  machine: Pick<MachineLike, "lastSeenAt">,
  now: number,
): boolean {
  return now - toEpoch(machine.lastSeenAt) > MACHINE_STALE_MS;
}

export interface MachineAvailability<T extends MachineLike> {
  // Non-stale machines, in the server's order.
  usable: T[];
  // Non-null when the user cannot delegate right now (no machine, or every
  // machine is offline) — shown as a hint and disables the delegate button.
  disabledReason: string | null;
  // The picker is HIDDEN when there is exactly one machine (nothing to choose);
  // it appears only when more than one machine exists.
  hidePicker: boolean;
}

// Derive the machine-picker presentation from the machine list + a clock. Pure
// so the "none" / "all stale" / "exactly one" / "several" branches are testable
// without a running daemon.
export function machineAvailability<T extends MachineLike>(
  machines: readonly T[] | undefined,
  now: number,
): MachineAvailability<T> {
  const all = machines ?? [];
  const usable = all.filter((m) => !isMachineStale(m, now));
  if (all.length === 0) {
    return {
      usable: [],
      disabledReason:
        "No machine connected. Start the Hitch daemon on a machine to delegate.",
      hidePicker: true,
    };
  }
  if (usable.length === 0) {
    return {
      usable: [],
      disabledReason:
        "No machine is online — the Hitch daemon hasn’t checked in recently.",
      hidePicker: all.length === 1,
    };
  }
  return { usable, disabledReason: null, hidePicker: all.length === 1 };
}

// ─── Prompt composition (Decision 2) ─────────────────────────────────────────

export interface DelegateTask {
  id: string;
  title: string;
  body: string;
}

// The machine-facing preamble stamped ahead of the chosen prompt. It orients a
// fresh agent to the task without assuming any Hitch machinery: the title, the
// body VERBATIM (capture text is sacred — embedded byte-for-byte, never
// transformed), the task id, and one line noting the optional `hitch` CLI. Will
// may tweak the wording; the shape (title, verbatim body, id, CLI line) is the
// contract the unit test pins.
export function buildDelegatePreamble(task: DelegateTask): string {
  const hasBody = task.body.trim() !== "";
  return [
    `You're picking up the Hitch task "${task.title}".`,
    "",
    "Here is the full task description, verbatim:",
    "",
    hasBody ? task.body : "(No description was written.)",
    "",
    `Task id: ${task.id}`,
    "If the `hitch` CLI is installed, you can use it to read this task, add" +
      " comments, and mark it complete — run `hitch --help` to see how.",
  ].join("\n");
}

// The final prompt stamped VERBATIM into assignments.prompt: the preamble
// followed by the user's chosen prompt text (a preset body or their one-off
// edit). A blank prompt collapses to just the preamble. The preamble is always
// present, so the composed result is never empty — callers may still treat an
// empty return as "no prompt", but in practice one never occurs.
export function composeDelegatePrompt(
  task: DelegateTask,
  promptText: string,
): string {
  const preamble = buildDelegatePreamble(task);
  return promptText.trim() === "" ? preamble : `${preamble}\n\n${promptText}`;
}

// ─── Last-agent seed (V2-local) ──────────────────────────────────────────────

// V2 stores only the harness (no model/effort), so it keeps its OWN last-agent
// key rather than sharing V1's hitch:last-agent blob — the two never collide,
// and a V2 delegation can't rewrite a V1 model/effort choice.
const V2_LAST_HARNESS_KEY = "hitch:v2:last-harness";

function isServerHarness(value: unknown): value is ServerHarness {
  return value === "claude" || value === "codex";
}

// The bar seeds its agent picker from the user's last V2 delegation, falling
// back to Claude Code. Guarded for the no-window (test node) path.
export function loadLastHarness(): ServerHarness {
  if (typeof window === "undefined") return "claude";
  try {
    const raw = window.localStorage.getItem(V2_LAST_HARNESS_KEY);
    return isServerHarness(raw) ? raw : "claude";
  } catch {
    return "claude";
  }
}

export function saveLastHarness(harness: ServerHarness): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(V2_LAST_HARNESS_KEY, harness);
  } catch {
    // Private-mode / quota failures are non-fatal — we just don't remember.
  }
}
