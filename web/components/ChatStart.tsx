"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Terminal } from "lucide-react";

import {
  defaultStartPrompt,
  HARNESSES,
  harnessLabel,
  type Harness,
} from "@/lib/chat";
import { Button } from "@/components/ui/button";

// Launch a brand-new coding-agent session for a task that isn't linked yet.
// The browser enqueues a local daemon command; the daemon performs the OS/app
// work, then the new session writes its chat id back to the task.
export function ChatStart({
  workspace,
  source,
  path,
  title,
}: {
  workspace: string;
  source: string;
  path: string;
  title: string;
}) {
  const enqueue = useMutation(api.commands.enqueueCommand);
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
      await enqueue({
        workspace,
        kind: "start-chat",
        harness,
        source,
        path,
        initialPrompt: prompt,
      });
    } finally {
      // Leave the button busy briefly: the daemon spawn is async and the card
      // only flips to "linked" once the agent writes its id back.
      setTimeout(() => setStarting(false), 1500);
    }
  }

  const label = harnessLabel(harness);
  const buttonLabel =
    harness === "codex" ? "Open in Codex" : `Start in ${label}`;
  const busyLabel = harness === "codex" ? "Opening…" : "Starting…";
  const helpText =
    harness === "codex"
      ? "Opens Codex with this prompt ready. Press Enter in Codex to start, and the new thread will link itself back to this task."
      : "Spawns a local Claude Code session; Hitch links it back to this task once it starts.";

  return (
    <section className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Start a chat
        </span>
        <div className="flex items-center gap-2">
          <select
            aria-label="Chat harness"
            value={harness}
            onChange={(e) => changeHarness(e.target.value as Harness)}
            disabled={starting}
            className="h-7 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {HARNESSES.map((h) => (
              <option key={h} value={h}>
                {harnessLabel(h)}
              </option>
            ))}
          </select>
          <Button size="xs" onClick={start} disabled={starting}>
            <Terminal />
            {starting ? busyLabel : buttonLabel}
          </Button>
        </div>
      </div>
      <textarea
        aria-label="Start prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        spellCheck={false}
        rows={6}
        className="w-full resize-none rounded-md border bg-transparent p-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-xs text-muted-foreground/70">
        {helpText}
      </p>
    </section>
  );
}
