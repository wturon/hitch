"use client";

import { Fragment, useEffect, useState } from "react";
import {
  GaugeIcon,
  SendHorizontalIcon,
  Settings2Icon,
  TextIcon,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";

import {
  DEFAULT_STARTING_PROMPTS,
  HARNESSES,
  MODELS_BY_HARNESS,
  buildStartPrompt,
  chatActivity,
  defaultEnvironment,
  defaultModel,
  defaultReasoning,
  environmentLabel,
  harnessLabel,
  honorsLaunchParams,
  isEnvironment,
  loadStartingPrompts,
  modelLabel,
  reasoningLabel,
  reasoningOptions,
  type ChatActivity,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
  type Environment,
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
  onManageHarnesses,
}: {
  projectId: Id<"projects">;
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  chatOpenState: ChatOpenState | null;
  title: string;
  path: string;
  onStart: (params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) => Promise<void> | void;
  onClear: () => void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}) {
  const [harness, setHarness] = useState<Harness>("codex");
  const [model, setModel] = useState(() => defaultModel("codex"));
  const [effort, setEffort] = useState(() =>
    defaultReasoning("codex", defaultModel("codex")),
  );
  // Per-harness run environment, read from the local daemon bridge. Claude in an
  // editor extension can't take model/effort at launch, so we disable those
  // controls for that case and point the user at the editor.
  const [harnessEnvs, setHarnessEnvs] = useState<Record<string, string>>({});
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

  // Read the per-harness environment preference once, so we know whether the
  // selected harness honors launch params (Claude in vscode/cursor does not).
  useEffect(() => {
    const bridge =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              hitchDaemon?: {
                getHarnessEnvironments?: () => Promise<Record<string, string>>;
              };
            }
          ).hitchDaemon
        : undefined;
    if (!bridge?.getHarnessEnvironments) return;
    void bridge
      .getHarnessEnvironments()
      .then((map) => setHarnessEnvs(map ?? {}))
      .catch(() => {});
  }, []);

  // The combined agent dropdown picks a (harness, model) pair at once. Switching
  // either resets reasoning to that model's default, since Codex exposes effort
  // as model capability metadata.
  function chooseAgent(value: string) {
    const sep = value.indexOf("|");
    const nextHarness = value.slice(0, sep) as Harness;
    const nextModel = value.slice(sep + 1);
    setModel(nextModel);
    if (nextHarness !== harness) {
      setHarness(nextHarness);
    }
    if (nextHarness !== harness || nextModel !== model) {
      setEffort(defaultReasoning(nextHarness, nextModel));
    }
  }

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
      await onStart({ harness, model, effort, prompt });
    } finally {
      // The daemon spawn is async; the band only flips to "linked" once the
      // agent writes its id back, so keep the button busy briefly.
      setTimeout(() => setStarting(false), 1500);
    }
  }

  // Whether the current (harness, environment) pair accepts model/effort at
  // launch. Unset env falls back to the harness default.
  const storedEnv = harnessEnvs[harness];
  const currentEnv: Environment = isEnvironment(storedEnv ?? "")
    ? (storedEnv as Environment)
    : defaultEnvironment(harness);
  const paramsHonored = honorsLaunchParams(harness, currentEnv);

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

  // Ghost-styled trigger for the controls that live inside the composer chrome —
  // borderless so the header/footer read as one surface, not boxed sub-inputs.
  const chipTrigger =
    "h-7 gap-1.5 border-0 px-2 font-normal hover:bg-muted";

  return (
    <section className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Delegate to an agent
      </span>

      {/* The prompt builder: one surface with the starting-prompt picker in its
          header, the editable instructions in the body, and the agent + reasoning
          controls plus the launch button in the footer. */}
      <div className="flex flex-col overflow-hidden rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring">
        {/* Header — starting prompt. Decoupled from the agent: it seeds the text
            below and doesn't reset when the harness changes. */}
        <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1">
          <TextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Starting prompt</span>
          <Select
            value={promptId}
            onValueChange={(value) => choosePreset(value as string)}
          >
            <SelectTrigger aria-label="Starting prompt" className={chipTrigger}>
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

        {/* Body — the instructions, freely editable for one-off tweaks. */}
        <textarea
          aria-label="Delegation instructions"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          rows={6}
          className="w-full resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
        />

        {/* Footer — agent (harness + model) and reasoning on the left, launch on
            the right. */}
        <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-0.5">
            {/* Combined harness + model picker: models are grouped under their
                harness, so choosing a model also fixes the harness. */}
            <Select
              value={`${harness}|${model}`}
              onValueChange={(value) => chooseAgent(value as string)}
            >
              <SelectTrigger aria-label="Agent and model" className={chipTrigger}>
                <SelectValue>
                  {(value: string) => {
                    const sep = value.indexOf("|");
                    const h = value.slice(0, sep) as Harness;
                    const m = value.slice(sep + 1);
                    return (
                      <span className="flex items-center gap-1.5">
                        <HarnessIcon harness={h} className="size-4" />
                        <span className="font-medium">{harnessLabel(h)}</span>
                        <span className="text-muted-foreground">
                          {modelLabel(h, m)}
                        </span>
                      </span>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HARNESSES.map((h) => (
                  <Fragment key={h}>
                    <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                      <HarnessIcon harness={h} className="size-3.5" />
                      {harnessLabel(h)}
                    </div>
                    {MODELS_BY_HARNESS[h].map((m) => (
                      <SelectItem
                        key={`${h}|${m.id}`}
                        value={`${h}|${m.id}`}
                        className="pl-7"
                      >
                        {m.label}
                      </SelectItem>
                    ))}
                  </Fragment>
                ))}
              </SelectContent>
            </Select>

            <span className="h-4 w-px shrink-0 bg-border" aria-hidden />

            {/* Reasoning/effort — harness-specific; disabled when the chosen
                harness/environment can't accept it at launch. */}
            <Select
              value={effort}
              onValueChange={(value) => setEffort(value as string)}
              disabled={!paramsHonored}
            >
              <SelectTrigger
                aria-label="Reasoning effort"
                className={chipTrigger}
              >
                <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue>
                  {(value: string) => reasoningLabel(harness, value, model)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {reasoningOptions(harness, model).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={start} disabled={starting} className="shrink-0">
            <SendHorizontalIcon className="size-4" />
            {starting ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>

      {!paramsHonored && (
        <p className="text-xs text-amber-600 dark:text-amber-400/90">
          For Claude Code in {environmentLabel(currentEnv)}, model and reasoning
          are set in the editor window.{" "}
          {onManageHarnesses && (
            <button
              type="button"
              onClick={onManageHarnesses}
              className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
            >
              Manage your preferred harness environments here
            </button>
          )}
        </p>
      )}
    </section>
  );
}
