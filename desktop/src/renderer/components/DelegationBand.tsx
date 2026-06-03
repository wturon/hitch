"use client";

import { useState } from "react";
import type { Id } from "@convex/_generated/dataModel";

import {
  HARNESSES,
  chatActivity,
  defaultStartPrompt,
  harnessLabel,
  type ChatActivity,
  type ChatRef,
  type ChatStatus,
  type Harness,
} from "@/lib/chat";
import { HarnessIcon } from "@/components/HarnessIcon";
import { ChatLaunch } from "@/components/ChatLaunch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The live activity badge on a linked chat. "none" (no signal) renders nothing —
// common for Codex, which has no status hooks.
function StatusPill({ activity }: { activity: ChatActivity }) {
  if (activity === "none") return null;
  const working = activity === "working";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        working
          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          working && "animate-pulse",
        )}
        aria-hidden
      />
      {working ? "working" : "not working"}
    </span>
  );
}

// One band that handles both halves of delegation: composing a new run (pick a
// harness, edit the instructions, kick it off) and the linked state (show the
// running/linked agent with a resume + unlink). Which half shows is driven by
// the live `chat` ref, so it flips on its own once the daemon links the session.
export function DelegationBand({
  projectId,
  chat,
  chatStatus,
  title,
  path,
  onStart,
  onClear,
}: {
  projectId: Id<"projects">;
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  title: string;
  path: string;
  onStart: (harness: Harness, prompt: string) => Promise<void> | void;
  onClear: () => void;
}) {
  const [harness, setHarness] = useState<Harness>("codex");
  const [prompt, setPrompt] = useState(() =>
    defaultStartPrompt({ title, path }, "codex"),
  );
  const [starting, setStarting] = useState(false);

  function changeHarness(next: Harness) {
    setHarness(next);
    setPrompt(defaultStartPrompt({ title, path }, next));
  }

  async function start() {
    setStarting(true);
    try {
      await onStart(harness, prompt);
    } finally {
      // The daemon spawn is async; the band only flips to "linked" once the
      // agent writes its id back, so keep the button busy briefly.
      setTimeout(() => setStarting(false), 1500);
    }
  }

  if (chat) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Delegated
        </span>
        <div className="flex items-center gap-3 rounded-md border bg-background p-2.5">
          <HarnessIcon harness={chat.harness} className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {harnessLabel(chat.harness)}
              </span>
              <StatusPill activity={chatActivity(chatStatus)} />
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {chat.id}
              {chat.cwd ? ` · ${chat.cwd}` : ""}
            </p>
          </div>
          <ChatLaunch
            chat={chat}
            status={chatStatus}
            projectId={projectId}
            size="sm"
          />
          <Button variant="ghost" size="xs" onClick={onClear}>
            Clear
          </Button>
        </div>
      </section>
    );
  }

  const label = harnessLabel(harness);
  return (
    <section className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Delegate to an agent
        </span>
        <div className="flex items-center gap-2">
          <Select
            value={harness}
            onValueChange={(value) => changeHarness(value as Harness)}
          >
            <SelectTrigger aria-label="Harness" className="w-44">
              <SelectValue>
                {(value: Harness) => (
                  <span className="flex items-center gap-2">
                    <HarnessIcon harness={value} className="size-4" />
                    {harnessLabel(value)}
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {HARNESSES.map((h) => (
                <SelectItem key={h} value={h}>
                  <HarnessIcon harness={h} className="size-4" />
                  {harnessLabel(h)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={start} disabled={starting}>
            {starting ? "Starting…" : `Save & start with ${label}`}
          </Button>
        </div>
      </div>
      <textarea
        aria-label="Delegation instructions"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        spellCheck={false}
        rows={6}
        className="w-full resize-none rounded-md border bg-transparent p-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-xs text-muted-foreground/70">
        Sent to the agent when it starts. Edit to add special delegation
        instructions.
      </p>
    </section>
  );
}
