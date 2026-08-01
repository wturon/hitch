// Pure logic for the delegate band's "Link a chat" picker. No React, no HTTP —
// the house shape of chatLane/todoGroups/delegation, so which chats are offered,
// in what order, and how each one reads are unit-tested rather than eyeballed
// inside a popover.
//
// WHY THE PICKER EXISTS: until it did, a chat became linked to a task only if
// Hitch spawned it. That made the cmux delegate button the MECHANISM rather than
// a shortcut, and it meant a machine's chats were fully observable but
// unattachable. Linking is its own action now; the delegate button is unchanged
// and remains the fast path.
//
// This module deliberately re-derives NOTHING the server already decided. The
// chat's status is the server-derived column (src/chatStatus.ts, from the three
// observation axes); we only choose the words and the grouping.

import type { ServerHarness } from "./delegation";

// ─── The chat shape the picker reads ─────────────────────────────────────────

/**
 * The subset of GET /chats a picker row needs — a structural subset of the real
 * row, so the query's type satisfies it without a cast.
 */
export interface LinkableChatFields {
  id: string;
  machineId: string;
  projectId: string | null;
  harness: ServerHarness;
  title: string;
  /** The harness-native session id. Null only on legacy pre-snapshot rows. */
  sessionId: string | null;
  cwd: string | null;
  status: "busy" | "waiting_input" | "idle" | "dead";
  existence: "running" | "dormant" | "pending" | null;
  lastActivityAt: string | Date;
  machineName: string;
  projectName: string | null;
  /** The task this chat already serves, if any (server-joined). */
  task: { id: string; title: string } | null;
}

// ─── Status wording ──────────────────────────────────────────────────────────

export interface ChatStatusWord {
  label: string;
  /** The one amber mark a row is allowed: an agent blocked on the user. */
  needsYou: boolean;
}

/**
 * How a chat's state reads in the picker.
 *
 * `existence` outranks `status` for the two cases where the status column alone
 * would overstate what is there: a dormant chat is resumable but nothing is
 * running, and a pending one has been claimed but not yet seen. Both derive to
 * "idle" server-side, which is correct as a STATUS and misleading as a label —
 * "Idle" on a row invites you to link something that is not actually sitting in
 * a terminal waiting for you.
 */
export function chatStatusWord(
  chat: Pick<LinkableChatFields, "status" | "existence">,
): ChatStatusWord {
  if (chat.existence === "pending") return { label: "Starting…", needsYou: false };
  if (chat.existence === "dormant") return { label: "Dormant", needsYou: false };
  switch (chat.status) {
    case "busy":
      return { label: "Working", needsYou: false };
    case "waiting_input":
      return { label: "Needs you", needsYou: true };
    case "idle":
      return { label: "Idle", needsYou: false };
    case "dead":
      // Filtered out before this is reached; kept total rather than throwing.
      return { label: "Gone", needsYou: false };
  }
}

/**
 * The row's second line: where the chat is and what it's doing. The cwd is the
 * only honest label for a chat outside every hitched folder, so it is always
 * shown rather than falling back to the project name — two chats in the same
 * project are told apart by their directory, not by repeating the project.
 */
export function chatLocationLine(chat: LinkableChatFields): string {
  const parts = [chat.cwd?.trim() || chat.projectName?.trim() || "unknown folder"];
  parts.push(chatStatusWord(chat).label);
  return parts.join(" · ");
}

// ─── Selection + grouping ────────────────────────────────────────────────────

export interface LinkableChat<T> {
  chat: T;
  /**
   * Non-null when the chat cannot be picked, and WHY, in the words the row
   * shows. A chat already serving another task stays visible and disabled: it
   * answers "where did my chat go" without a round trip, and the alternative —
   * hiding it — reads as the picker having lost track of it.
   */
  disabledReason: string | null;
}

export interface LinkableChatGroups<T> {
  /** Chats whose cwd resolved to the task's own project. Offered first. */
  inProject: LinkableChat<T>[];
  /** Everything else on the machine, still reachable. */
  elsewhere: LinkableChat<T>[];
  /** Rows across both groups — the picker's empty check. */
  total: number;
}

function epoch(value: string | Date): number {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Which chats this task can link, grouped and ordered.
 *
 * Dropped entirely:
 *   - dead, or with no existence observation at all. This MIRRORS the server's
 *     `chatIsAttachable` predicate (routes/chatPredicates.ts) rather than
 *     inventing a second rule: offering a row the route would reject, or that
 *     the reconciler would immediately mark dead, is worse than not offering it.
 *   - no session id. The link route is keyed on the harness-native id, so a
 *     legacy row has nothing to address.
 *   - already serving THIS task — it is in the lane above, and re-linking it is
 *     a no-op the server answers 200 to. Nothing is gained by offering it twice.
 *
 * Kept but disabled: a chat serving ANOTHER task (the server's one-task-per-chat
 * rule, enforced in the /link transaction).
 *
 * Order inside a group is most-recently-active first — the picker is used
 * moments after the user was in the chat, so recency is the ranking that puts
 * the answer under the cursor. Ties break by id DESC (uuidv7 ids are
 * creation-ordered), the same total order the lane sorts by.
 */
export function linkableChats<T extends LinkableChatFields>(
  chats: readonly T[] | undefined,
  task: { taskId: string; projectId: string | null },
): LinkableChatGroups<T> {
  const inProject: LinkableChat<T>[] = [];
  const elsewhere: LinkableChat<T>[] = [];

  for (const chat of chats ?? []) {
    if (chat.status === "dead" || chat.existence === null) continue;
    if (chat.sessionId === null) continue;
    if (chat.task?.id === task.taskId) continue;
    const takenBy = chat.task?.title.trim();
    const entry: LinkableChat<T> = {
      chat,
      disabledReason: chat.task
        ? takenBy
          ? `On “${takenBy}”`
          : "On another task"
        : null,
    };
    const mine = task.projectId !== null && chat.projectId === task.projectId;
    (mine ? inProject : elsewhere).push(entry);
  }

  const byRecency = (a: LinkableChat<T>, b: LinkableChat<T>) => {
    const delta = epoch(b.chat.lastActivityAt) - epoch(a.chat.lastActivityAt);
    return delta !== 0 ? delta : b.chat.id.localeCompare(a.chat.id);
  };
  inProject.sort(byRecency);
  elsewhere.sort(byRecency);
  return { inProject, elsewhere, total: inProject.length + elsewhere.length };
}

/**
 * The cmdk search key for a row. cmdk matches on this string, so it carries
 * everything a user might type to find a session again: its title, the folder
 * it runs in, its harness, and its machine.
 */
export function chatSearchValue(chat: LinkableChatFields): string {
  return [chat.title, chat.cwd ?? "", chat.harness, chat.machineName, chat.id]
    .filter((part) => part !== "")
    .join(" ");
}
