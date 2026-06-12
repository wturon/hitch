"use client";

import type { Id } from "@convex/_generated/dataModel";
import { ExternalLink, Info, LoaderCircle, Terminal } from "lucide-react";

import {
  harnessLabel,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { useOpenChat } from "@/lib/useOpenChat";
import { Button } from "@/components/ui/button";
import { CmuxAccessDialog } from "@/components/CmuxAccessDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Leading glyph for the launch button: the chat's live state when we have one
// (spinner while working, a pulsing amber dot when it's blocked on you, a steady
// dot once it's your turn — the "blue dot"), otherwise the harness's own icon.
// Keeps status visually grouped with the chat.
function LaunchIcon({
  status,
  fallback,
}: {
  status: ChatStatus | null | undefined;
  fallback: React.ReactNode;
}) {
  if (status === "working")
    return <LoaderCircle className="animate-spin" aria-label="Working" />;
  if (status === "needs-input")
    return (
      <span
        className="size-2 animate-pulse rounded-full bg-amber-500"
        aria-label="Needs input"
      />
    );
  if (status === "waiting")
    return <span className="size-2 rounded-full bg-current" aria-hidden />;
  return fallback;
}

// The "jump back to the chat" control. It enqueues an open command for the local
// daemon so each harness can honor the user's preferred environment.
// `stopPropagation` lets it sit on a clickable card without triggering the card.
export function ChatLaunch({
  chat,
  status,
  openState,
  projectId,
  size = "sm",
  stopPropagation = false,
  className,
}: {
  chat: ChatRef;
  status?: ChatStatus | null;
  openState?: ChatOpenState | null;
  projectId: Id<"projects">;
  size?: "xs" | "sm" | "default";
  stopPropagation?: boolean;
  className?: string;
}) {
  const {
    opening,
    launchOpen,
    cmuxReason,
    setCmuxReason,
    focusHint,
    setFocusHint,
  } = useOpenChat(chat, projectId);

  const stop = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
  };

  if (chat.harness === "codex" && openState === "pending") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className={cn("inline-flex", className)}
              aria-label="Why Codex cannot open yet"
            />
          }
        >
          <Button
            variant="secondary"
            size={size}
            disabled
            aria-label="Codex first turn is running"
          >
            <LaunchIcon status={status} fallback={<ExternalLink />} />
            Opening Codex…
            <Info className="opacity-70" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          Hitch is using Codex app-server to run the first turn. When it
          finishes, you can open the chat in your selected editor.
        </TooltipContent>
      </Tooltip>
    );
  }

  async function open(e: React.MouseEvent) {
    stop(e);
    await launchOpen();
  }

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        onClick={open}
        disabled={opening}
        className={className}
      >
        <LaunchIcon
          status={status}
          fallback={chat.harness === "codex" ? <ExternalLink /> : <Terminal />}
        />
        {opening ? (
          "Opening…"
        ) : (
          <>
            Open in {harnessLabel(chat.harness)}
          </>
        )}
      </Button>
      {focusHint && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs leading-4 text-amber-700 dark:text-amber-400/90">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{focusHint}</span>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              setFocusHint(null);
            }}
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
    </>
  );
}
