"use client";

import { ArrowUpRight } from "lucide-react";

import { HarnessIcon } from "@/components/HarnessIcon";
import { cn } from "@/lib/utils";
import type { ServerHarness } from "./delegation";
import type { HarnessChipState } from "./todoGroups";
import { useOpenChat, type OpenChatTarget } from "./useOpenChat";

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

// V1's icon vocabulary is `claude-code | codex`; the V2 server enum is
// `claude | codex`. Map at the boundary so nothing else has to know.
function iconHarness(harness: ServerHarness): "claude-code" | "codex" {
  return harness === "codex" ? "codex" : "claude-code";
}

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
      <span className="relative flex size-[22px] items-center justify-center rounded-full bg-muted">
        <HarnessIcon harness={iconHarness(harness)} className="size-[13px]" />
        {state === "needs-you" && (
          <span className="absolute -bottom-px -right-px size-[9px] rounded-full bg-amber-500 ring-2 ring-background" />
        )}
      </span>
    </span>
  );
}

/**
 * The chip, or the empty slot that holds its place.
 *
 * `state === null` renders a fixed-width spacer rather than nothing: chips and
 * tag pills then form a straight column down the list instead of ragging with
 * whichever rows happen to have an agent.
 */
export function HarnessChipSlot({
  harness,
  state,
  target,
}: {
  harness: ServerHarness | null;
  state: HarnessChipState | null;
  /** The assignment's chat + machine — where "open" sends its focus event. */
  target: OpenChatTarget | null;
}) {
  const { canOpen, openChat } = useOpenChat(target);

  if (state === null || harness === null) {
    return <span className="h-7 w-7 shrink-0" aria-hidden />;
  }

  return (
    <span className="relative flex h-7 shrink-0 items-center justify-end">
      <button
        type="button"
        data-testid="v2-harness-chip"
        data-chip-state={state}
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
            ? `Open chat — agent is ${stateWord(state)}`
            : `Agent is ${stateWord(state)} — its chat hasn’t started yet`
        }
        className="relative inline-flex items-center rounded-full p-[3px] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70"
      >
        <ChipRing state={state} />
        <ChipBody
          harness={harness}
          state={state}
          label={canOpen ? "Open chat" : "Starting…"}
        />
      </button>
    </span>
  );
}
