"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { ExternalLink, LoaderCircle, Terminal } from "lucide-react";

import {
  harnessLabel,
  launchFor,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { Button } from "@/components/ui/button";

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
  workspace,
  size = "sm",
  stopPropagation = false,
  className,
}: {
  chat: ChatRef;
  status?: ChatStatus | null;
  workspace: string;
  size?: "xs" | "sm" | "default";
  stopPropagation?: boolean;
  className?: string;
}) {
  const launch = launchFor(chat);
  const enqueue = useMutation(api.commands.enqueueCommand);
  const [opening, setOpening] = useState(false);

  const stop = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
  };

  if (launch.kind === "url") {
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

  async function open(e: React.MouseEvent) {
    stop(e);
    setOpening(true);
    try {
      await enqueue({
        workspace,
        kind: "open-chat",
        harness: "claude-code",
        sessionId: chat.id,
        cwd: chat.cwd,
      });
    } finally {
      setTimeout(() => setOpening(false), 1500);
    }
  }

  return (
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
  );
}
