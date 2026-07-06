"use client";

import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";

import {
  chatActivity,
  harnessLabel,
  type ChatRef,
  type ChatStatus,
  type DelegationRequest,
} from "@/lib/chat";
import { useOpenChat } from "@/lib/useOpenChat";
import { Kbd } from "@/components/ui/kbd";
import { HarnessIcon } from "@/components/HarnessIcon";
import { CmuxAccessDialog } from "@/components/CmuxAccessDialog";
import { cn } from "@/lib/utils";

// The existing-todo footer states (Todos v1, slice 5). These replace the compose
// panel once a todo has a linked chat or a pending/failed request, mirroring
// DelegationBand's linked (:305) and requested/failed (:341) footers but wearing
// the docked-panel chrome the todo dialog uses (one tinted surface, no floating
// band). The shared surface matches TodoDelegateFooter so the swap between
// states reads as a content change, not a relayout.
const SURFACE =
  "rounded-b-xl border-t border-t-[#E8E8E8] bg-[#F9F9F9] px-5 py-3 dark:border-t-border dark:bg-muted/40";

// The embedded ⌘⏎ chip, matching the Start button's (KRN-0). Reused by the
// black Open chat / Retry buttons that ⌘⏎ triggers. Shared shadcn Kbd, tinted
// translucent so it reads on the dark button (the AppSidebar on-colored pattern).
function KbdChip() {
  return (
    <Kbd className="border border-white/20 bg-white/15 text-white/85 dark:border-background/20 dark:bg-background/15 dark:text-background/85">
      ⌘⏎
    </Kbd>
  );
}

// A black, 32px primary action carrying a label + the embedded ⌘⏎ chip — the
// same silhouette as the compose Start button, reused for Open chat and Retry.
function PrimaryAction({
  label,
  busyLabel,
  busy,
  onClick,
  ariaLabel,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={ariaLabel}
      className="flex h-8 shrink-0 items-center gap-1.75 rounded-md bg-[#0B0B0B] px-3 text-white disabled:opacity-70 dark:bg-foreground dark:text-background"
    >
      {busy ? (
        <span className="text-[13px] font-semibold">{busyLabel ?? label}</span>
      ) : (
        <>
          <span className="text-[13px] font-semibold">{label}</span>
          <KbdChip />
        </>
      )}
    </button>
  );
}

// The harness avatar for the linked footer: the brand mark in a neutral circle,
// wrapped by a status ring — the animated "spinner" ring while working (the same
// hitch-spin-ring HarnessChip uses), a faint static ring otherwise.
function ChatChip({
  harness,
  working,
}: {
  harness: ChatRef["harness"];
  working: boolean;
}) {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
      <HarnessIcon harness={harness} className="size-3.5" />
      {working ? (
        <span
          className="hitch-spin-ring pointer-events-none absolute inset-0 rounded-full"
          aria-hidden
        />
      ) : (
        <span
          className="pointer-events-none absolute inset-0 rounded-full border-[1.5px] border-border"
          aria-hidden
        />
      )}
    </span>
  );
}

// The status/time line under the linked chat's title. Monochrome by design:
// working/idle stay muted; only needs-input earns amber (the "your turn"
// moment). Recency is the file's own updatedAt (the daemon bumps it on every
// projected chat-status write), rendered by the caller's relativeTime.
function LinkedStatus({
  status,
  when,
}: {
  status: ChatStatus | null;
  when: string;
}) {
  const activity = chatActivity(status);
  if (activity === "working") {
    return (
      <span className="truncate text-[12px] text-muted-foreground">
        Working…
      </span>
    );
  }
  if (activity === "needs-input") {
    return (
      <span className="truncate text-[12px] font-medium text-amber-600 dark:text-amber-400">
        Needs input · {when}
      </span>
    );
  }
  return (
    <span className="truncate text-[12px] text-muted-foreground">
      Idle · {when}
    </span>
  );
}

// LINKED (and linked-completed): a chat is attached. Chip + task title + live
// status/time, and a black "Open chat" that ⌘⏎ fires. The resume flow is the
// shared useOpenChat plumbing DelegationBand/HarnessChip use, so cmux access and
// the T3Code focus hint keep working. When `ghostChip` (the completed case) the
// chip dims to ~35% so the chat stays reachable but recedes, matching how DONE
// rows ghost their chip.
export function TodoLinkedFooter({
  chat,
  chatStatus,
  title,
  when,
  projectId,
  ready,
  ghostChip = false,
}: {
  chat: ChatRef;
  chatStatus: ChatStatus | null;
  title: string;
  when: string;
  projectId: Id<"projects">;
  // ⌘⏎ arms Open chat only once the card has settled (no transform in flight).
  ready: boolean;
  ghostChip?: boolean;
}) {
  const {
    opening,
    launchOpen,
    cmuxReason,
    setCmuxReason,
    focusHint,
    setFocusHint,
  } = useOpenChat(chat, projectId);

  const working = chatActivity(chatStatus) === "working";

  // ⌘⏎ → Open chat (the linked state's primary action). Gated to `ready`, and
  // suppressed while a menu/dialog is open, mirroring the compose composer's arm.
  useEffect(() => {
    if (!ready) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || !e.metaKey || e.shiftKey || e.altKey || e.repeat)
        return;
      if (
        document.querySelector(
          '[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      void launchOpen();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ready, launchOpen]);

  return (
    <div className={cn(SURFACE, "flex flex-col gap-2")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn(ghostChip && "opacity-35")}>
            <ChatChip harness={chat.harness} working={working} />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-semibold text-[#1B1B1B] dark:text-foreground">
              {title}
            </span>
            <LinkedStatus status={chatStatus} when={when} />
          </div>
        </div>
        <PrimaryAction
          label="Open chat"
          busyLabel="Opening…"
          busy={opening}
          onClick={() => void launchOpen()}
          ariaLabel={`Open chat in ${harnessLabel(chat.harness)}`}
        />
      </div>
      {focusHint && (
        <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs leading-4 text-amber-700 dark:text-amber-400/90">
          <span className="min-w-0">{focusHint}</span>
          <button
            type="button"
            onClick={() => setFocusHint(null)}
            className="ml-auto shrink-0 font-medium underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
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

// REQUESTED / FAILED: a launch is in flight (or failed) with no chat bound yet.
//   requested — a neutral "Requested" pill + "Starting <harness>…" + Cancel
//               request (clears the request flag → the todo derives to Backlog).
//   failed    — an amber "Failed to start" pill + the daemon's error + Retry,
//               which re-fires the delegation (⌘⏎). Cancel is a quiet text
//               button (no ⌘⏎); Retry is the black primary.
//
// Model isn't carried in the request frontmatter (only the harness is stamped),
// so the "Starting …" line names the harness alone — see the PR notes.
export function TodoRequestFooter({
  request,
  ready,
  onCancel,
  onRetry,
}: {
  request: DelegationRequest;
  ready: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const failed = request.state === "failed";

  // ⌘⏎ → Retry (failed only). Cancel-on-requested has no keyboard arm (it's the
  // quiet, non-destructive escape hatch, not the primary action).
  useEffect(() => {
    if (!failed || !ready) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || !e.metaKey || e.shiftKey || e.altKey || e.repeat)
        return;
      if (
        document.querySelector(
          '[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      onRetry();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [failed, ready, onRetry]);

  return (
    <div className={cn(SURFACE, "flex items-center justify-between gap-3")}>
      <div className="flex min-w-0 items-center gap-2.5">
        {failed ? (
          <span className="shrink-0 rounded-full border border-amber-500/50 px-2 py-0.5 text-[11.5px] font-medium text-amber-700 dark:text-amber-400">
            Failed to start
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#D8D8D8] px-2 py-0.5 text-[11.5px] font-medium text-[#565656] dark:border-border dark:text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
            Requested
          </span>
        )}
        <span className="truncate text-[12.5px] text-muted-foreground">
          {failed
            ? request.error?.trim() || "Couldn’t start"
            : `Starting ${harnessLabel(request.harness)}…`}
        </span>
      </div>
      {failed ? (
        <PrimaryAction
          label="Retry"
          onClick={onRetry}
          ariaLabel="Retry delegation"
        />
      ) : (
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-[#555555] hover:bg-black/5 hover:text-foreground dark:text-muted-foreground"
        >
          Cancel request
        </button>
      )}
    </div>
  );
}
