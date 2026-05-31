"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";

import { harnessLabel, launchFor, type ChatRef } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// The "jump back to the chat" control.
// - Codex: a deep link the OS routes to the desktop app.
// - Claude Code: enqueue a command for the local daemon to open it in cmux
//   (focus the existing pane, or spawn a resume). Copy-the-command stays as a
//   fallback for when no daemon is connected.
// `stopPropagation` lets it sit on a clickable card without triggering the card.
export function ChatLaunch({
  chat,
  workspace,
  size = "sm",
  stopPropagation = false,
  className,
}: {
  chat: ChatRef;
  workspace: string;
  size?: "xs" | "sm" | "default";
  stopPropagation?: boolean;
  className?: string;
}) {
  const launch = launchFor(chat);
  const enqueue = useMutation(api.commands.enqueueCommand);
  const [copied, setCopied] = useState(false);
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
        render={<a href={launch.url} onClick={stop} />}
      >
        <ExternalLink />
        {launch.label}
      </Button>
    );
  }

  // Past the early return, `launch` is the copy variant; capture the command
  // here so the closures below don't lose the narrowing.
  const command = launch.command;

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

  function copy(e: React.MouseEvent) {
    stop(e);
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Button variant="secondary" size={size} onClick={open} disabled={opening}>
        <Terminal />
        {opening ? (
          "Opening…"
        ) : (
          <>
            Open in {harnessLabel(chat.harness)}
            <span className="text-muted-foreground">(cmux)</span>
          </>
        )}
      </Button>
      <Button
        variant="ghost"
        size={size === "xs" ? "icon-xs" : "icon-sm"}
        onClick={copy}
        aria-label="Copy resume command"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </span>
  );
}
