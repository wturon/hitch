"use client";

import { Fragment, useEffect, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  GaugeIcon,
  LoaderCircle,
  PencilIcon,
  Settings2Icon,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";

import {
  BUILTIN_PROMPT_IDS,
  BUILTIN_STARTING_PROMPTS,
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
  loadCustomPrompts,
  modelLabel,
  promptDescription,
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

// The calm live status shown next to a linked agent. Monochrome by design:
// working/idle stay muted; amber is reserved for the one "your turn" moment
// (needs-input). "none" (no signal — common for Codex) renders nothing.
function DelegatedStatus({ activity }: { activity: ChatActivity }) {
  if (activity === "none") return null;
  if (activity === "working") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Working
      </span>
    );
  }
  if (activity === "needs-input") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <span
          className="size-1.5 animate-pulse rounded-full bg-current"
          aria-hidden
        />
        Needs input
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      Idle
    </span>
  );
}

// The floating delegate bar, pinned over the bottom of the task document. It has
// three states driven by the live `chat` ref (which rides the task frontmatter,
// so it flips on its own once the daemon links a session):
//   • compose / minimized — pick a preset + agent and Send in one click
//   • compose / expanded — the editable prompt grows above the controls
//   • delegated — the linked agent with Clear + Open
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
  const [prompts, setPrompts] = useState<StartingPrompt[]>(
    BUILTIN_STARTING_PROMPTS,
  );
  const [promptId, setPromptId] = useState(BUILTIN_STARTING_PROMPTS[0].id);
  const [prompt, setPrompt] = useState(() =>
    buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], { title, path }),
  );
  const [starting, setStarting] = useState(false);
  // Whether the prompt editor is revealed. Minimized is the default calm state.
  const [expanded, setExpanded] = useState(false);

  // (Re)load the custom prompts and reset the selection to the first built-in
  // ("Ship it") whenever the dialog switches to a different task — the band isn't
  // remounted per task, so title/path change underneath us, and re-running here
  // also picks up prompts edited in settings. The dropdown shows the built-ins
  // first, then the customs. The harness no longer changes the prompt — prompts
  // are decoupled.
  useEffect(() => {
    let active = true;
    setPromptId(BUILTIN_STARTING_PROMPTS[0].id);
    setPrompt(buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], { title, path }));
    void loadCustomPrompts().then((custom) => {
      if (!active) return;
      setPrompts([...BUILTIN_STARTING_PROMPTS, ...custom]);
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

  // Shared floating-surface chrome: white, hairline border, soft drop shadow.
  const surface =
    "rounded-xl border bg-background shadow-[0_12px_32px_rgba(0,0,0,0.16)]";

  if (chat) {
    return (
      <div
        className={cn(
          surface,
          "flex items-center justify-between gap-2 py-2.5 pr-2.5 pl-3.5",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <HarnessIcon harness={chat.harness} className="size-5 shrink-0" />
          <span className="truncate text-sm font-semibold">
            {harnessLabel(chat.harness)}
          </span>
          <DelegatedStatus activity={chatActivity(chatStatus)} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
          <ChatLaunch
            chat={chat}
            status={chatStatus}
            openState={chatOpenState}
            projectId={projectId}
            size="sm"
            label="Open"
            primary
          />
        </div>
      </div>
    );
  }

  // Ghost-styled, borderless triggers for the controls inside the bar, so the
  // pickers read as inline chips rather than boxed sub-inputs.
  const chipTrigger = "h-7 gap-1.5 border-0 px-2 font-normal hover:bg-muted";

  return (
    <div className={cn(surface, "flex flex-col overflow-hidden")}>
      {/* Row 1 — the starting prompt: preset picker, its plain-English summary,
          and Edit (which expands the editable prompt below). */}
      <div className="flex items-center justify-between gap-2.5 py-2.5 pr-2.5 pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={promptId}
            onValueChange={(value) => choosePreset(value as string)}
          >
            <SelectTrigger
              aria-label="Starting prompt"
              className="h-7 shrink-0 gap-1 rounded-md border-0 bg-muted px-2 text-[13px] font-semibold text-foreground hover:bg-muted/70"
            >
              <SelectValue>
                {(value: string) =>
                  prompts.find((p) => p.id === value)?.name ?? "Select a prompt"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {prompts
                .filter((p) => BUILTIN_PROMPT_IDS.has(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              {/* User's custom prompts, set apart from the built-ins above. */}
              {prompts.some((p) => !BUILTIN_PROMPT_IDS.has(p.id)) && (
                <>
                  <div className="my-1 h-px bg-border" />
                  {prompts
                    .filter((p) => !BUILTIN_PROMPT_IDS.has(p.id))
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </>
              )}
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
          <span className="truncate text-[13px] text-muted-foreground">
            {promptDescription(
              prompts.find((p) => p.id === promptId) ??
                BUILTIN_STARTING_PROMPTS[0],
            )}
          </span>
        </div>

        {expanded ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse prompt"
            onClick={() => setExpanded(false)}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronDown />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(true)}
            className="shrink-0"
          >
            <PencilIcon />
            Edit
          </Button>
        )}
      </div>

      {/* The editable prompt — revealed on expand, freely editable for one-off
          tweaks; never written back to the saved preset. */}
      {expanded && (
        <textarea
          aria-label="Delegation instructions"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          rows={6}
          autoFocus
          className="w-full resize-none border-0 bg-transparent px-3 pb-1 font-mono text-xs leading-relaxed outline-none"
        />
      )}

      {/* Row 2 — the controls: agent + model and reasoning on the left, the
          black up-arrow Send on the right. Stays put as the prompt expands. */}
      <div className="flex items-center justify-between gap-2 border-t py-2 pr-2 pl-2.5">
        <div className="flex min-w-0 items-center gap-1">
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
            <SelectTrigger aria-label="Reasoning effort" className={chipTrigger}>
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

        {/* Send — the primary one-click trigger. Black rounded square, up-arrow,
            no text. */}
        <Button
          onClick={start}
          disabled={starting}
          aria-label="Delegate to agent"
          className="size-8 shrink-0 rounded-lg p-0"
        >
          {starting ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <ArrowUp className="size-4" strokeWidth={2.5} />
          )}
        </Button>
      </div>

      {!paramsHonored && (
        <p className="border-t bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400/90">
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
    </div>
  );
}
