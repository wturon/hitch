"use client";

import { Fragment, useState } from "react";
import {
  ChevronUp,
  GaugeIcon,
  LoaderCircle,
  PencilIcon,
  Settings2Icon,
} from "lucide-react";

import {
  BUILTIN_PROMPT_IDS,
  BUILTIN_STARTING_PROMPTS,
  HARNESSES,
  MODELS_BY_HARNESS,
  environmentLabel,
  harnessLabel,
  modelLabel,
  promptDescription,
  reasoningLabel,
  reasoningOptions,
  type Harness,
} from "@/lib/chat";
import {
  MANAGE_PROMPTS_VALUE,
  useDelegationComposer,
  type DelegationStartParams,
} from "@/hooks/useDelegationComposer";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The docked delegation panel (the todo dialog's stage-2 compose footer). One
// tinted surface, no internal hairlines: preset row over agent row ending in
// the black Start button with the embedded ⌘⏎ chip (KRN-0). The compose STATE
// MACHINE is the shared useDelegationComposer — the same model DelegationBand
// renders its floating chrome over; only the chrome differs here.
export function TodoDelegateFooter({
  title,
  path,
  ready,
  onStart,
  onManagePrompts,
  onManageHarnesses,
}: {
  title: string;
  path: string;
  // False during the transform window (Decision 5) so ⌘⏎ is swallowed until the
  // card settles; flips true to re-arm delegate-⌘⏎.
  ready: boolean;
  onStart: (params: DelegationStartParams) => Promise<void> | void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}) {
  const {
    phase,
    harness,
    model,
    effort,
    setEffort,
    prompts,
    promptId,
    prompt,
    setPrompt,
    chooseAgent,
    choosePreset,
    start,
    paramsHonored,
    currentEnv,
  } = useDelegationComposer({
    title,
    path,
    canStart: true,
    keyboardArmed: ready,
    onStart,
    onManagePrompts,
  });
  // Whether the one-off prompt editor is revealed (KXG-0). Pure chrome.
  const [expanded, setExpanded] = useState(false);

  const chip = "h-7 gap-1.5 border-0 px-1.5 font-normal hover:bg-black/5";

  return (
    <div className="flex flex-col gap-2.5 rounded-b-xl border-t border-t-[#E8E8E8] bg-[#F9F9F9] px-5 pt-3 pb-3.5 dark:border-t-border dark:bg-muted/40">
      {/* Preset row */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Select
            value={promptId}
            onValueChange={(value) => choosePreset(value as string)}
          >
            <SelectTrigger
              aria-label="Starting prompt"
              className="h-6.5 shrink-0 gap-1 rounded-sm border border-[#DEDEDE] bg-white px-2 text-[12.5px] font-semibold text-[#2E2E2E] hover:bg-white/70 dark:border-border dark:bg-background dark:text-foreground"
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
          <span className="truncate text-[12.5px] text-[#717171] dark:text-muted-foreground">
            {promptDescription(
              prompts.find((p) => p.id === promptId) ??
                BUILTIN_STARTING_PROMPTS[0],
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse prompt" : "Edit prompt"}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-[#555555] hover:bg-black/5 dark:text-muted-foreground"
        >
          {expanded ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <>
              <PencilIcon className="size-3" />
              Edit
            </>
          )}
        </button>
      </div>

      {/* The one-off editable prompt (never written back to the preset). */}
      {expanded && (
        <textarea
          aria-label="Delegation instructions"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          rows={6}
          autoFocus
          className="w-full resize-none rounded-md border border-[#E4E4E4] bg-white px-3 py-2 font-mono text-xs leading-relaxed outline-none dark:border-border dark:bg-background"
        />
      )}

      {/* Agent row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Select
            value={`${harness}|${model}`}
            onValueChange={(value) => chooseAgent(value as string)}
          >
            <SelectTrigger aria-label="Agent and model" className={chip}>
              <SelectValue>
                {(value: string) => {
                  const sep = value.indexOf("|");
                  const h = value.slice(0, sep) as Harness;
                  const m = value.slice(sep + 1);
                  return (
                    <span className="flex items-center gap-1.5">
                      <HarnessIcon harness={h} className="size-3.5" />
                      <span className="text-[13px] font-medium text-[#222222] dark:text-foreground">
                        {harnessLabel(h)}
                      </span>
                      <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
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

          <span
            className="h-3.5 w-px shrink-0 bg-[#DEDEDE] dark:bg-border"
            aria-hidden
          />

          <Select
            value={effort}
            onValueChange={(value) => setEffort(value as string)}
            disabled={!paramsHonored}
          >
            <SelectTrigger aria-label="Reasoning effort" className={chip}>
              <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue>
                {(value: string) => (
                  <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
                    {reasoningLabel(harness, value, model)}
                  </span>
                )}
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

        {/* Start — black, text + embedded ⌘⏎ chip (KRN-0). */}
        <button
          type="button"
          onClick={() => void start()}
          disabled={phase !== "idle"}
          aria-label="Start"
          className="flex h-8 shrink-0 items-center gap-1.75 rounded-md bg-[#0B0B0B] px-3 text-white disabled:opacity-70 dark:bg-foreground dark:text-background"
        >
          {phase !== "idle" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <>
              <span className="text-[13px] font-semibold">Start</span>
              <Kbd className="border border-white/20 bg-white/15 text-white/85 dark:border-background/20 dark:bg-background/15 dark:text-background/85">
                ⌘⏎
              </Kbd>
            </>
          )}
        </button>
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
    </div>
  );
}
