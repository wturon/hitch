// What a row's agent chips SHOW — the pure half of HarnessChip's stack.
//
// Slice 1 (todoGroups.ts) gave a task a LIST of chats and one reduce over it
// (`rowState`). This module turns that list into the handful of decisions the
// chrome needs, so each is unit-testable without mounting a list:
//
//   • rowChips        — a task's chats as the row addresses them (harness +
//                       chat/machine target + state), plus the row's single
//                       worst state and its ackable chat;
//   • capChipStack    — how many avatars are DRAWN vs. rolled into a "+N"
//                       count. A row's right edge must not move with the number
//                       of agents on it, and the full list already has a home:
//                       the task dialog's lane;
//   • liveTaskChips   — the collapsed-section rule: ONE chip per TASK (its worst
//                       state), never one per chat. A folded section holding
//                       five multi-chat tasks must not read as twenty discs.
//
// The severity order lives in todoGroups (`DEMAND`) and is reached only through
// `rowState` / the lane ordering — nothing here re-derives it, so the ring the
// user sees can't disagree with the group the task lands in.

import type { ObservedState, ServerHarness } from "./delegation";
import { rowState, type HarnessChipState, type TaskChat } from "./todoGroups";

/**
 * The minimal assignment fields a chip needs — a structural subset of what GET
 * /assignments returns. `chatId`/`machineId` address the focus event;
 * `observedState`/`reviewedAt` are read only to find the ackable chat (the
 * state itself already arrived mapped, on the `TaskChat`).
 */
export interface ChipAssignment {
  id: string;
  harness: ServerHarness;
  chatId: string | null;
  machineId: string | null;
  observedState: ObservedState;
  reviewedAt: string | Date | null;
}

/** One chat as a chip: what to draw, and where clicking it goes. */
export interface ChipChat {
  assignmentId: string;
  harness: ServerHarness;
  chatId: string | null;
  machineId: string | null;
  state: HarnessChipState;
}

/** Everything a row's chip slot renders from. */
export interface RowChips {
  /**
   * The task's chats in LANE order (todoGroups.chatsByTaskId): worst state
   * first, newest first inside a band. Empty means the empty slot.
   */
  chats: ChipChat[];
  /**
   * The row's single state — `rowState`'s reduce by demand over every chat, so
   * the stack's outer signal is the WORST thing on the task and never the
   * newest. `null` iff `chats` is empty.
   */
  state: HarnessChipState | null;
  /** The ackable assignment (done ∧ unreviewed), else null. */
  ackableId: string | null;
}

/**
 * A task's chats, resolved for the row. `chats` keeps the input order, which
 * callers get from `chatsByTaskId` — that ordering is what makes the FIRST chat
 * one that is in `state`, so the leading avatar's own ring and the row's outer
 * signal agree by construction.
 */
export function rowChips<T extends ChipAssignment>(
  chats: readonly TaskChat<T>[] | undefined,
): RowChips {
  const list = chats ?? [];
  return {
    chats: list.map(({ assignment, state }) => ({
      assignmentId: assignment.id,
      harness: assignment.harness,
      chatId: assignment.chatId,
      machineId: assignment.machineId,
      state,
    })),
    state: rowState(list),
    // The ackable chat need not be the leading one: a task can have a live
    // agent AND a finished-unreviewed one, and "Mark reviewed" belongs to the
    // latter. First in lane order, so it's the newest such chat.
    ackableId:
      list.find(
        ({ assignment }) =>
          assignment.observedState === "done" && assignment.reviewedAt == null,
      )?.assignment.id ?? null,
  };
}

/**
 * How many avatars a row's stack draws before the remainder becomes a count.
 *
 * Two, deliberately: the stack sits immediately right of the tag pills, and the
 * row's right edge has to stay put whether a task has two agents on it or nine.
 * "2 + a count" is a fixed three slots wide; the dialog's lane is where the full
 * list lives.
 */
export const CHIP_STACK_LIMIT = 2;

/** How many chips a COLLAPSED section's header shows before counting the rest. */
export const COLLAPSED_CHIP_LIMIT = 3;

/**
 * Split a chip list into what's drawn and what's counted. `overflow` is 0
 * whenever everything fits, so callers can test one number instead of comparing
 * lengths.
 */
export function capChipStack<T>(
  items: readonly T[],
  limit: number,
): { shown: T[]; overflow: number } {
  if (items.length <= limit) return { shown: [...items], overflow: 0 };
  return { shown: items.slice(0, limit), overflow: items.length - limit };
}

/** One inert chip for a collapsed section header: a TASK and its worst state. */
export interface TaskChip {
  taskId: string;
  harness: ServerHarness;
  /** Only the two states worth telegraphing from a folded header. */
  state: "needs-you" | "working";
}

/**
 * The agents a collapsed section is hiding — ONE chip per task, carrying that
 * task's worst state, `needs-you` tasks first so the one that wants a human is
 * never the one the cap truncates.
 *
 * Per TASK, not per chat: collapsing is how a long project gets short, and a
 * header that fans out every chat on every task defeats the fold. Idle chats
 * contribute nothing — a folded section only has to answer "is something in here
 * waiting on me, or still going".
 */
export function liveTaskChips(
  entries: readonly { taskId: string; chip: RowChips }[],
): TaskChip[] {
  const live: TaskChip[] = [];
  for (const { taskId, chip } of entries) {
    const state = chip.state;
    if (state !== "needs-you" && state !== "working") continue;
    // The harness of a chat actually IN that state (lane order puts it first),
    // so the disc's brand mark and its ring describe the same chat.
    const lead = chip.chats.find((chat) => chat.state === state) ?? chip.chats[0];
    if (!lead) continue;
    live.push({ taskId, harness: lead.harness, state });
  }
  // Stable within a band, so the header's order follows the section's own.
  return live.sort((a, b) => bandOf(a.state) - bandOf(b.state));
}

function bandOf(state: TaskChip["state"]): number {
  return state === "needs-you" ? 0 : 1;
}
