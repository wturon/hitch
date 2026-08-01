"use client";

import { ArrowUpRight } from "lucide-react";

import { HarnessIcon } from "@/components/HarnessIcon";
import { cn } from "@/lib/utils";
import { iconHarness, serverHarnessLabel, type ServerHarness } from "./delegation";
import { capChipStack, CHIP_STACK_LIMIT, type ChipChat } from "./chipStack";
import type { HarnessChipState } from "./todoGroups";
import { useOpenChat } from "./useOpenChat";

// The todo row's agent instrument — restored from V1's HarnessChip (deleted in
// the V2 cutover, ae50282) now that placement, not status, decides where a row
// sits. It is the ONLY thing on a row that says anything about an agent: the
// Working spinner, the amber "Needs input" text and the "Mark reviewed" button
// all came off when this came back.
//
// Its two structural ideas, carried over intact:
//
//   • The avatar carries the HARNESS's own color (brand identity); status lives
//     in the surrounding RING. Concentric, so a brand color and a status color
//     never sit side by side and start competing.
//   • At rest it is a plain 22px circle. On row hover it expands INLINE into a
//     pill reading "Open chat ↗", growing the row rightward rather than
//     overlaying the tag pills to its left (V1 tried the overlay; it clipped
//     the tags).
//
// Expansion is driven by the ROW's `group`, so hovering anywhere on the row
// summons the label — the chip is a 22px target but the whole row is the hint.
//
// MULTI-CHAT (slice 3): a task can carry several chats at once, so the slot
// takes a LIST. Two shapes, and the split is deliberate:
//
//   • ONE chat — the overwhelming majority of rows — renders exactly the chip
//     described above, unchanged down to the hover pill and its wording.
//   • TWO OR MORE render a STACK of overlapping discs that fans out on row
//     hover, each disc its own click target for its own chat. No text pill:
//     there is no room for one beside two avatars and a count, and "Open chat"
//     would be a lie about which chat anyway.
//
// The stack's outer signal is the row's WORST state (chipStack's `rowChips`,
// i.e. todoGroups' `rowState`), never its newest: a row must never look calm
// while something on it is blocked on the user. Lane order puts a chat in that
// worst state FIRST, so the leading disc — the one drawn fully in front —
// carries exactly that ring, and `data-chip-state` on the stack says the same.

function stateWord(state: HarnessChipState): string {
  if (state === "working") return "working";
  if (state === "needs-you") return "needs you";
  return "idle";
}

// The status ring at the chip's outer edge. It traces the rounded-full shape at
// any width, so it reads as a circle at rest and stretches into the pill
// outline on hover:
//   idle      — faint full border
//   needs-you — amber border, collapsing to neutral once expanded (the dot
//               carries the signal into the pill, so the label stays legible)
//   working   — the hitch-spin-ring: a hard-edged conic arc travelling the
//               ring. styles.css freezes it to an even ring under
//               prefers-reduced-motion.
function ChipRing({ state }: { state: HarnessChipState }) {
  if (state === "working") {
    return (
      <span
        className="hitch-spin-ring pointer-events-none absolute inset-0 rounded-full"
        aria-hidden
      />
    );
  }
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-0 rounded-full border-[1.5px] transition-colors",
        state === "needs-you"
          ? "border-amber-500 group-hover:border-border group-focus-within:border-border"
          : "border-border",
      )}
      aria-hidden
    />
  );
}

// The 22px disc itself: the harness mark on the neutral avatar field, plus the
// amber needs-you dot notched into its corner. Shared by the static chip and by
// the stack — the single chip's disc lives inside ChipBody, which also owns the
// pill it grows into.
function ChipAvatar({
  harness,
  state,
}: {
  harness: ServerHarness;
  state: HarnessChipState;
}) {
  return (
    <span className="relative flex size-[22px] items-center justify-center rounded-full bg-muted">
      <HarnessIcon harness={iconHarness(harness)} className="size-[13px]" />
      {state === "needs-you" && (
        <span
          className="absolute -bottom-px -right-px size-[9px] rounded-full bg-amber-500 ring-2 ring-background"
          aria-hidden
        />
      )}
    </span>
  );
}

// The collapsed state has no inter-element gap and no right padding so it stays
// a true 22px circle; the leading space before the label lives as the label's
// own (clipped) padding and only appears once expanded.
function ChipBody({
  harness,
  state,
  label,
}: {
  harness: ServerHarness;
  state: HarnessChipState;
  label: string;
}) {
  return (
    <span className="relative flex h-[22px] items-center rounded-full bg-muted pr-0 transition-[padding] duration-200 ease-out group-hover:pr-2 group-focus-within:pr-2 motion-reduce:transition-none">
      <span className="relative flex size-[22px] shrink-0 items-center justify-center">
        <HarnessIcon harness={iconHarness(harness)} className="size-[13px]" />
        {state === "needs-you" && (
          <span
            className="absolute -bottom-px -right-px size-[9px] rounded-full bg-amber-500 ring-2 ring-background"
            aria-hidden
          />
        )}
      </span>
      <span className="flex max-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0 opacity-0 transition-all duration-200 ease-out group-hover:max-w-[120px] group-hover:pl-1.5 group-hover:opacity-100 group-focus-within:max-w-[120px] group-focus-within:pl-1.5 group-focus-within:opacity-100 motion-reduce:transition-none">
        <span className="text-[12.5px] font-semibold leading-4 text-foreground/80">
          {label}
        </span>
        <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
      </span>
    </span>
  );
}

/**
 * The chip with no interaction — the avatar and its status ring, nothing else.
 *
 * Used in a collapsed section's header, where the chips are a reason to open
 * the section rather than a second route to the chat. Deliberately not a
 * button: the row that owns it isn't on screen, so "open chat" would act on
 * something the user can't see.
 *
 * ONE per TASK, never one per chat — see chipStack's `liveTaskChips`. A folded
 * section holding five multi-chat tasks has to read as five busy tasks, not as
 * twenty discs.
 */
export function StaticHarnessChip({
  harness,
  state,
}: {
  harness: ServerHarness;
  state: HarnessChipState;
}) {
  return (
    <span className="relative inline-flex items-center rounded-full p-[3px]" aria-hidden>
      <ChipRing state={state} />
      <ChipAvatar harness={harness} state={state} />
    </span>
  );
}

// One disc in the stack, and its own click target: it opens ITS chat, not the
// row's. Everything the single chip's button does about claiming clicks and
// about a chat that hasn't started yet applies here too.
//
// `index` drives the overlap: every disc after the first hangs 9px over its
// predecessor at rest and settles into a 4px gap on row hover. Driven by the
// ROW's `group` (never per-chip hover) so the whole stack fans as one gesture
// and the fan can't chase the pointer between discs.
function StackChip({ chat, index }: { chat: ChipChat; index: number }) {
  const { canOpen, blockedBy, openChat } = useOpenChat({
    chatId: chat.chatId,
    machineId: chat.machineId,
    handle: chat.handle,
  });
  const harness = serverHarnessLabel(chat.harness);
  // The stack has no pill to withhold (see the file header), so the two reasons
  // a disc can't be clicked are told apart in its label alone.
  const label = canOpen
    ? `Open ${harness} chat — agent is ${stateWord(chat.state)}`
    : blockedBy === "no-handle"
      ? `${harness} agent is ${stateWord(chat.state)} — started outside Hitch, so it can’t be brought forward`
      : `${harness} agent is ${stateWord(chat.state)} — its chat hasn’t started yet`;
  return (
    <button
      type="button"
      data-testid="v2-harness-chip-avatar"
      data-chip-state={chat.state}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openChat();
      }}
      disabled={!canOpen}
      aria-label={label}
      title={label}
      className={cn(
        // bg-background on the 3px ring gutter is what makes overlapping discs
        // read as separate discs rather than as one clipped blob.
        "relative inline-flex items-center rounded-full bg-background p-[3px] outline-none transition-[margin] duration-200 ease-out focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70 motion-reduce:transition-none",
        stackLayer(index),
        index > 0 && "-ml-[9px] group-hover:ml-1 group-focus-within:ml-1",
      )}
    >
      <ChipRing state={chat.state} />
      <ChipAvatar harness={chat.harness} state={chat.state} />
    </button>
  );
}

// Painted front-to-back, so the LEADING disc — the one whose ring carries the
// row's worst state — is never the one its neighbour clips.
function stackLayer(index: number): string {
  if (index === 0) return "z-20";
  if (index === 1) return "z-10";
  return "z-0";
}

// The chats the cap didn't draw, as a count. Inert and aria-hidden: the stack's
// own sr-only total says how many chats the task has, and the discs the count
// stands for are reachable from the task dialog's lane rather than from a
// disclosure the row has no room for.
//
// It joins the cluster but does NOT overlap into it: the discs behind it are
// only ever partly visible, which is fine for a repeated avatar and useless for
// a number you have to read.
function StackOverflow({ count }: { count: number }) {
  return (
    <span
      className="relative z-0 inline-flex items-center rounded-full bg-background p-[3px] transition-[margin] duration-200 ease-out group-hover:ml-1 group-focus-within:ml-1 motion-reduce:transition-none"
      aria-hidden
    >
      <span className="flex size-[22px] items-center justify-center rounded-full border-[1.5px] border-border bg-muted text-[10px] font-semibold leading-none tabular-nums text-muted-foreground">
        +{count}
      </span>
    </span>
  );
}

/**
 * The chip, or the empty slot that holds its place.
 *
 * `chats` is the task's chats in LANE order (chipStack's `rowChips`), and
 * `state` is the row's worst one. An empty list renders a fixed-width spacer
 * rather than nothing: chips and tag pills then form a straight column down the
 * list instead of ragging with whichever rows happen to have an agent.
 */
export function HarnessChipSlot({
  chats,
  state,
}: {
  chats: readonly ChipChat[];
  /** The row's worst state (`rowChips().state`); null = the empty slot. */
  state: HarnessChipState | null;
}) {
  const lead = chats[0];
  if (state === null || lead === undefined) {
    return <span className="h-7 w-7 shrink-0" aria-hidden />;
  }
  if (chats.length === 1) return <SingleChip chat={lead} />;
  return <ChipStack chats={chats} state={state} />;
}

// The one-chat row, which is nearly every row: V1's chip verbatim — 22px
// circle, hover-expanded "Open chat ↗" pill, "Starting…" while the daemon has
// yet to link a chat. Nothing about the plural reaches this path.
function SingleChip({ chat }: { chat: ChipChat }) {
  const { canOpen, blockedBy, openChat } = useOpenChat({
    chatId: chat.chatId,
    machineId: chat.machineId,
    handle: chat.handle,
  });
  // A chat Hitch never launched has nowhere to go — so the row does not grow a
  // pill inviting the click. It stays the plain 22px disc it is at rest, and the
  // status it carries is still the whole point of it being there. Clicking falls
  // through to the row, which opens the task; the dialog's lane is where the
  // "why can't I open this" answer lives.
  if (blockedBy === "no-handle") {
    return (
      <span className="relative flex h-7 shrink-0 items-center justify-end">
        <span
          data-testid="v2-harness-chip"
          data-chip-state={chat.state}
          data-chip-count={1}
          title={`Agent is ${stateWord(chat.state)} — started outside Hitch, so it can’t be brought forward`}
          className="relative inline-flex items-center rounded-full p-[3px]"
        >
          <ChipRing state={chat.state} />
          <ChipAvatar harness={chat.harness} state={chat.state} />
        </span>
      </span>
    );
  }
  return (
    <span className="relative flex h-7 shrink-0 items-center justify-end">
      <button
        type="button"
        data-testid="v2-harness-chip"
        data-chip-state={chat.state}
        data-chip-count={1}
        // The row opens the task; the chip opens the CHAT. Both are legitimate
        // targets in the same 42px, so the chip has to claim its own clicks.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          openChat();
        }}
        disabled={!canOpen}
        aria-label={
          canOpen
            ? `Open chat — agent is ${stateWord(chat.state)}`
            : `Agent is ${stateWord(chat.state)} — its chat hasn’t started yet`
        }
        className="relative inline-flex items-center rounded-full p-[3px] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70"
      >
        <ChipRing state={chat.state} />
        <ChipBody
          harness={chat.harness}
          state={chat.state}
          label={canOpen ? "Open chat" : "Starting…"}
        />
      </button>
    </span>
  );
}

// The plural: overlapping discs at rest, fanned apart on row hover, capped at
// CHIP_STACK_LIMIT + a count so the row's right edge doesn't move with the
// number of agents on the task.
//
// `data-testid="v2-harness-chip"` sits on the stack rather than on any one disc,
// so a row still has EXACTLY ONE element carrying the row's `data-chip-state` —
// the arity of the row is what changed, not the instrument e2e reads.
function ChipStack({
  chats,
  state,
}: {
  chats: readonly ChipChat[];
  state: HarnessChipState;
}) {
  const { shown, overflow } = capChipStack(chats, CHIP_STACK_LIMIT);
  return (
    <span className="relative flex h-7 shrink-0 items-center justify-end">
      <span
        data-testid="v2-harness-chip"
        data-chip-state={state}
        data-chip-count={chats.length}
        className="flex items-center"
      >
        {shown.map((chat, index) => (
          <StackChip key={chat.assignmentId} chat={chat} index={index} />
        ))}
        {overflow > 0 && <StackOverflow count={overflow} />}
        <span className="sr-only">
          {chats.length} agent chats on this todo
        </span>
      </span>
    </span>
  );
}
