"use client";

import { useEffect, useState } from "react";
import { Settings2Icon } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";

import {
  DEFAULT_STARTING_PROMPTS,
  HARNESSES,
  buildStartPrompt,
  chatActivity,
  harnessLabel,
  loadStartingPrompts,
  type ChatActivity,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
  type Harness,
  type StartingPrompt,
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

// Sentinel value for the dropdown's footer action. It's not a real preset id —
// selecting it jumps to the Settings prompt manager instead of picking a prompt.
const MANAGE_PROMPTS_VALUE = "__manage_prompts__";

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
  chatOpenState,
  title,
  path,
  onStart,
  onClear,
  onManagePrompts,
}: {
  projectId: Id<"projects">;
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  chatOpenState: ChatOpenState | null;
  title: string;
  path: string;
  onStart: (harness: Harness, prompt: string) => Promise<void> | void;
  onClear: () => void;
  onManagePrompts?: () => void;
}) {
  const [harness, setHarness] = useState<Harness>("codex");
  const [prompts, setPrompts] =
    useState<StartingPrompt[]>(DEFAULT_STARTING_PROMPTS);
  const [promptId, setPromptId] = useState(DEFAULT_STARTING_PROMPTS[0].id);
  const [prompt, setPrompt] = useState(() =>
    buildStartPrompt(DEFAULT_STARTING_PROMPTS[0], { title, path }),
  );
  const [starting, setStarting] = useState(false);

  // Load the saved prompt library once and seed the textarea from the first
  // preset. The harness no longer changes the prompt — prompts are decoupled.
  useEffect(() => {
    let active = true;
    void loadStartingPrompts().then((loaded) => {
      if (!active || loaded.length === 0) return;
      setPrompts(loaded);
      setPromptId(loaded[0].id);
      setPrompt(buildStartPrompt(loaded[0], { title, path }));
    });
    return () => {
      active = false;
    };
  }, [title, path]);

  // Picking a preset refills the textarea, which stays freely editable for
  // one-off tweaks — edits never write back to the saved preset. The sentinel
  // value is a footer action (jump to settings), not a real preset.
  function choosePreset(id: string) {
    if (id === MANAGE_PROMPTS_VALUE) {
      onManagePrompts?.();
      return;
    }
    const preset = prompts.find((p) => p.id === id);
    if (!preset) return;
    setPromptId(id);
    setPrompt(buildStartPrompt(preset, { title, path }));
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
            openState={chatOpenState}
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
            onValueChange={(value) => setHarness(value as Harness)}
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
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Starting prompt</span>
        <Select
          value={promptId}
          onValueChange={(value) => choosePreset(value as string)}
        >
          <SelectTrigger aria-label="Starting prompt" className="w-56">
            <SelectValue>
              {(value: string) =>
                prompts.find((p) => p.id === value)?.name ?? "Select a prompt"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {prompts.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
            {onManagePrompts && (
              <>
                <div className="my-1 h-px bg-border" />
                <SelectItem
                  value={MANAGE_PROMPTS_VALUE}
                  className="text-muted-foreground"
                >
                  <Settings2Icon className="size-3.5 shrink-0" />
                  Manage prompts in settings…
                </SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
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
        Sent to the agent when it starts. Edit for one-off tweaks, or manage
        presets in Settings → Starting prompts.
      </p>
    </section>
  );
}
