"use client";

import type { Id } from "@convex/_generated/dataModel";
import { ArrowUpRight, Info } from "lucide-react";

import {
  harnessLabel,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
  type DelegationRequest,
} from "@/lib/chat";
import { useOpenChat } from "@/lib/useOpenChat";
import { HarnessIcon } from "@/components/HarnessIcon";
import { CmuxAccessDialog } from "@/components/CmuxAccessDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The three presentations the chip distinguishes. Idle and working stay neutral
// gray; only needs-input earns color (amber) so the board reads calm at a glance.
type ChipState = "idle" | "working" | "needs-input";

function chipState(status: ChatStatus | null | undefined): ChipState {
  if (status === "working") return "working";
  if (status === "needs-input") return "needs-input";
  return "idle"; // null / "waiting"
}

function stateWord(state: ChipState): string {
  if (state === "working") return "working";
  if (state === "needs-input") return "needs input";
  return "idle";
}

// The harness avatar: the brand mark centered in a neutral circle. The avatar
// carries the harness's own color (identity); status lives in the surrounding
// ring (concentric, so brand and status colors never sit side-by-side). The
// needs-input amber dot pins to the avatar so it rides along into the pill.
function ChipAvatar({
  harness,
  state,
}: {
  harness: ChatRef["harness"];
  state: ChipState;
}) {
  return (
    <span className="relative flex size-[22px] shrink-0 items-center justify-center">
      <HarnessIcon harness={harness} className="size-[13px]" />
      {state === "needs-input" && (
        <span
          className="absolute -bottom-px -right-px size-[9px] rounded-full bg-amber-500 ring-2 ring-card"
          aria-hidden
        />
      )}
    </span>
  );
}

// The status ring drawn at the chip's outer edge. It traces the rounded-full
// shape at any width, so it reads as a circle at rest and stretches into the
// pill outline on hover:
//   idle        — faint full border
//   needs-input — amber border (collapses to neutral when expanded; the dot
//                 carries the signal in the pill, matching the Paper spec)
//   working     — animated conic "spinner" ring (a traveling arc), static under
//                 prefers-reduced-motion
function ChipRing({ state }: { state: ChipState }) {
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
        state === "needs-input"
          ? "border-amber-500 group-hover:border-border group-focus-within:border-border"
          : "border-border",
      )}
      aria-hidden
    />
  );
}

// The expand-on-hover body shared by every state: a neutral, perfectly circular
// avatar at rest that, when the card is hovered/focused, reveals "Open chat ↗".
// Expansion is driven by the card's `group` (set on the DraggableCard root) so
// hovering anywhere on the card summons the pill. The collapsed state has no
// inter-element gap and no right padding so it stays a true 22px circle; the
// leading space before the label lives as the label's own (clipped) padding and
// only appears once it expands.
function ChipBody({
  harness,
  state,
  label,
  disabledReason = false,
}: {
  harness: ChatRef["harness"];
  state: ChipState;
  label: string;
  disabledReason?: boolean;
}) {
  const expandedContentWidth = disabledReason
    ? "group-hover:max-w-[144px] group-focus-within:max-w-[144px]"
    : "group-hover:max-w-[120px] group-focus-within:max-w-[120px]";

  return (
    <span className="relative flex h-[22px] items-center rounded-full bg-muted pr-0 transition-[padding] duration-200 ease-out group-hover:pr-2 group-focus-within:pr-2 motion-reduce:transition-none">
      <ChipAvatar harness={harness} state={state} />
      <span
        className={cn(
          "flex max-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0 opacity-0 transition-all duration-200 ease-out group-hover:pl-1.5 group-hover:opacity-100 group-focus-within:pl-1.5 group-focus-within:opacity-100 motion-reduce:transition-none",
          expandedContentWidth,
        )}
      >
        <span className="text-[12.5px] font-semibold leading-4 text-foreground/80">
          {label}
        </span>
        {disabledReason ? (
          <Info className="size-3 shrink-0 text-muted-foreground/80" />
        ) : (
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
        )}
      </span>
    </span>
  );
}

// The board card's corner control: at a glance it signals an agent is assigned,
// which harness, and the chat's live status; on hover/focus it expands into a
// labeled link that jumps to the chat. Built on the shared useOpenChat plumbing
// so the cmux access dialog and T3Code focus hint keep working.
export function HarnessChip({
  chat,
  status,
  openState,
  projectId,
}: {
  chat: ChatRef;
  status?: ChatStatus | null;
  openState?: ChatOpenState | null;
  projectId: Id<"projects">;
}) {
  const {
    opening,
    launchOpen,
    cmuxReason,
    setCmuxReason,
    focusHint,
    setFocusHint,
  } = useOpenChat(chat, projectId);
  const state = chipState(status);

  // Codex's first turn runs inside the daemon-managed app-server; opening the
  // deep link during that window strands the user, so the chip is inert (with a
  // tooltip) until the turn finishes. Mirrors ChatLaunch's pending guard.
  const pending = chat.harness === "codex" && openState === "pending";

  if (pending) {
    return (
      <div className="relative flex h-7 justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="relative inline-flex items-center rounded-full p-[3px] opacity-70"
              />
            }
            aria-label="Why Codex cannot open yet"
          >
            <ChipRing state="working" />
            <ChipBody
              harness={chat.harness}
              state="working"
              label="Working…"
              disabledReason
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            Hitch is using Codex app-server to run the first turn. When it
            finishes, you can open the chat in your selected editor.
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    // The chip expands inline on hover/focus (its body animates max-width), so it
    // grows the row rightward rather than overlaying the tags to its left. The
    // overlay approach clipped the tag pills under the opaque pill; per review we
    // keep tags readable and accept the small hover-time shift. What actually
    // stops rows swapping under the cursor is the deterministic attention-group
    // sort (todos.ts byCreatedDesc), not this footprint.
    <div className="relative flex h-7 justify-end">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void launchOpen();
        }}
        disabled={opening}
        aria-label={`Open chat in ${harnessLabel(chat.harness)} — ${stateWord(state)}`}
        className="relative inline-flex items-center rounded-full p-[3px] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
      >
        <ChipRing state={state} />
        <ChipBody
          harness={chat.harness}
          state={state}
          label={opening ? "Opening…" : "Open chat"}
        />
      </button>
      {focusHint && (
        <FocusHint hint={focusHint} onDismiss={() => setFocusHint(null)} />
      )}
      {cmuxReason && (
        <CmuxAccessDialog
          open
          onOpenChange={(next) => {
            if (!next) setCmuxReason(null);
          }}
          reason={cmuxReason}
          onRetry={() => void launchOpen()}
        />
      )}
    </div>
  );
}

// The corner chip for a task that has *summoned* an agent but has no bound chat
// yet — the durable, fire-and-forget "requested" flag (or a "failed" launch). It
// reuses the same avatar/ring/expand-on-hover body as HarnessChip so the board
// reads consistently, but it's inert: there's nothing to open yet, so a click
// falls through to open the task (where a failed request can be cleared).
//   requested — spinner ring, softened, "Requested"
//   failed    — amber ring + dot, "Couldn't start" (+ the reason in the tooltip)
export function RequestChip({ request }: { request: DelegationRequest }) {
  const failed = request.state === "failed";
  const state: ChipState = failed ? "needs-input" : "working";
  const label = failed ? "Couldn’t start" : "Requested";
  const tip = failed
    ? request.error?.trim() ||
      "The launch couldn’t start. Open the task to clear it and try again."
    : `Summoning ${harnessLabel(request.harness)}… waiting for it to pick up the task.`;

  return (
    <div className="relative flex h-7 justify-end">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className={cn(
                "relative inline-flex items-center rounded-full p-[3px]",
                !failed && "opacity-70",
              )}
            />
          }
          aria-label={label}
        >
          <ChipRing state={state} />
          <ChipBody
            harness={request.harness}
            state={state}
            label={label}
            disabledReason
          />
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{tip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// T3Code focus can only reveal the window when Hitch didn't launch the app. The
// labeled ChatLaunch shows this inline; the corner chip has no room, so it
// surfaces the same guidance as a small dismissible toast pinned to the window.
function FocusHint({
  hint,
  onDismiss,
}: {
  hint: string;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-80 items-start gap-1.5 rounded-md border bg-card p-3 text-xs leading-4 text-amber-700 shadow-lg dark:text-amber-400/90">
      <span className="min-w-0">{hint}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="ml-auto shrink-0 font-medium underline hover:no-underline"
      >
        Dismiss
      </button>
    </div>
  );
}
