"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

import { launchFor, type ChatRef } from "@/lib/chat";
import { Button } from "@/components/ui/button";

// The "jump back to the chat" control. For Codex it's a deep link the OS routes
// to the desktop app; for Claude Code it copies a `claude --resume` command,
// since no resume URL exists. `stopPropagation` lets it sit on a clickable card
// without also triggering the card.
export function ChatLaunch({
  chat,
  size = "sm",
  stopPropagation = false,
  className,
}: {
  chat: ChatRef;
  size?: "xs" | "sm" | "default";
  stopPropagation?: boolean;
  className?: string;
}) {
  const launch = launchFor(chat);
  const [copied, setCopied] = useState(false);

  if (launch.kind === "url") {
    return (
      <Button
        variant="secondary"
        size={size}
        className={className}
        render={
          <a
            href={launch.url}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
            }}
          />
        }
      >
        <ExternalLink />
        {launch.label}
      </Button>
    );
  }

  return (
    <Button
      variant="secondary"
      size={size}
      className={className}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        void navigator.clipboard?.writeText(launch.command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : launch.label}
    </Button>
  );
}
