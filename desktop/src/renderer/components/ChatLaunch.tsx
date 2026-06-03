"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { ExternalLink, Info, LoaderCircle, Terminal } from "lucide-react";

import {
  harnessLabel,
  launchFor,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { Button } from "@/components/ui/button";
import {
  CmuxAccessDialog,
  type CmuxAccessReason,
} from "@/components/CmuxAccessDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Leading glyph for the launch button: the chat's live state when we have one
// (spinner while working, a steady dot once it's your turn — the "blue dot"),
// otherwise the harness's own icon. Keeps status visually grouped with the chat.
function LaunchIcon({
  status,
  fallback,
}: {
  status: ChatStatus | null | undefined;
  fallback: React.ReactNode;
}) {
  if (status === "working")
    return <LoaderCircle className="animate-spin" aria-label="Working" />;
  if (status === "waiting")
    return <span className="size-2 rounded-full bg-current" aria-hidden />;
  return fallback;
}

// The "jump back to the chat" control.
// - Codex: a deep link the OS routes to the desktop app.
// - Claude Code: enqueue a command for the local daemon to open it in cmux
//   (focus the existing pane, or spawn a resume).
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
  const launch = launchFor(chat);
  const enqueue = useMutation(api.commands.enqueueCommand);
  const [opening, setOpening] = useState(false);
  // Watch the launch command we just enqueued so we can react to how the daemon
  // resolved it — chiefly to guide the user when cmux refuses the connection.
  const [pendingCommandId, setPendingCommandId] =
    useState<Id<"commands"> | null>(null);
  const [cmuxReason, setCmuxReason] = useState<CmuxAccessReason | null>(null);
  const command = useQuery(
    api.commands.getCommand,
    pendingCommandId ? { id: pendingCommandId, projectId } : "skip",
  );

  useEffect(() => {
    if (!command || command.status === "pending") return;
    // Terminal: stop watching. Open the guided dialog for the cmux failures we
    // recognize; other outcomes (done, or an unrecognized error) just clear.
    setPendingCommandId(null);
    if (
      command.status === "error" &&
      (command.errorCode === "cmux-access-denied" ||
        command.errorCode === "cmux-unavailable")
    ) {
      setCmuxReason(command.errorCode);
    }
  }, [command]);

  const stop = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
  };

  if (launch.kind === "url") {
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
              aria-label="Codex thread is starting"
            >
              <LaunchIcon status={status} fallback={<ExternalLink />} />
              Codex starting…
              <Info className="opacity-70" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-56">
            You'll be able to open the chat after the first turn. This may take
            a few minutes.
          </TooltipContent>
        </Tooltip>
      );
    }

    return (
      <Button
        variant="secondary"
        size={size}
        className={className}
        nativeButton={false}
        render={<a href={launch.url} onClick={stop} aria-label={launch.label} />}
      >
        <LaunchIcon status={status} fallback={<ExternalLink />} />
        {launch.label}
      </Button>
    );
  }

  async function launchOpen() {
    setOpening(true);
    try {
      const id = await enqueue({
        projectId,
        kind: "open-chat",
        harness: "claude-code",
        sessionId: chat.id,
        cwd: chat.cwd,
      });
      setPendingCommandId(id);
    } finally {
      setTimeout(() => setOpening(false), 1500);
    }
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
        <LaunchIcon status={status} fallback={<Terminal />} />
        {opening ? (
          "Opening…"
        ) : (
          <>
            Open in {harnessLabel(chat.harness)}
            <span className="text-muted-foreground">(cmux)</span>
          </>
        )}
      </Button>
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
