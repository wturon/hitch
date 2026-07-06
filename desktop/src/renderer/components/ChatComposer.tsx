"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUp, GaugeIcon, LoaderCircle } from "lucide-react";
import {
  HARNESSES,
  MODELS_BY_HARNESS,
  defaultEnvironment,
  defaultModel,
  defaultReasoning,
  environmentLabel,
  harnessLabel,
  honorsLaunchParams,
  isEnvironment,
  modelLabel,
  reasoningLabel,
  reasoningOptions,
  type Environment,
  type Harness,
} from "@/lib/chat";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The "Start a chat" composer — a freeform prompt box with a harness/model and
// effort picker and a Send button. Reuses the delegate-to-agent control logic
// from the task dialog's DelegationBand, minus the preset row and (per the PRD)
// any link control: chats started here are always standalone.
export function ChatComposer({
  onStart,
  onManageHarnesses,
  wide,
  defaultPrompt,
  label = "Start a chat",
}: {
  onStart: (params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) => Promise<void> | void;
  onManageHarnesses?: () => void;
  wide?: boolean;
  // Prefill the textarea (e.g. the note launcher's "I need your help in …").
  // When set, the caret lands at the END of the text on mount so the user keeps
  // typing after it rather than overwriting it.
  defaultPrompt?: string;
  // The small heading above the box. Defaults to "Start a chat"; pass null to
  // drop it where the surrounding surface already frames the action (the note
  // foot), or a string to override it.
  label?: string | null;
}) {
  const [harness, setHarness] = useState<Harness>("codex");
  const [model, setModel] = useState(() => defaultModel("codex"));
  const [effort, setEffort] = useState(() =>
    defaultReasoning("codex", defaultModel("codex")),
  );
  const [prompt, setPrompt] = useState(defaultPrompt ?? "");
  const [starting, setStarting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Per-harness run environment, read from the local daemon bridge. Claude in an
  // editor extension can't take model/effort at launch, so those controls are
  // disabled for that case (same rule the DelegationBand follows).
  const [harnessEnvs, setHarnessEnvs] = useState<Record<string, string>>({});

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

  // Prefilled prompts (the note launcher) land the caret at the end, not
  // selected, so the user continues the sentence. Once on mount.
  useEffect(() => {
    if (!defaultPrompt) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The combined agent dropdown picks a (harness, model) pair at once; switching
  // either resets reasoning to that model's default (Codex exposes effort as
  // model capability metadata).
  function chooseAgent(value: string) {
    const sep = value.indexOf("|");
    const nextHarness = value.slice(0, sep) as Harness;
    const nextModel = value.slice(sep + 1);
    setModel(nextModel);
    if (nextHarness !== harness) setHarness(nextHarness);
    if (nextHarness !== harness || nextModel !== model) {
      setEffort(defaultReasoning(nextHarness, nextModel));
    }
  }

  async function start() {
    const trimmed = prompt.trim();
    if (!trimmed || starting) return;
    setStarting(true);
    try {
      await onStart({ harness, model, effort, prompt: trimmed });
      setPrompt("");
    } finally {
      // The daemon spawn is async; brief busy state mirrors the DelegationBand.
      setTimeout(() => setStarting(false), 600);
    }
  }

  const storedEnv = harnessEnvs[harness];
  const currentEnv: Environment = isEnvironment(storedEnv ?? "")
    ? (storedEnv as Environment)
    : defaultEnvironment(harness);
  const paramsHonored = honorsLaunchParams(harness, currentEnv);

  // Ghost-styled, borderless triggers so the pickers read as inline chips.
  const chipTrigger = "h-7 gap-1.5 border-0 px-2 font-normal hover:bg-muted";

  return (
    <div className={cn("mx-auto w-full", wide ? "max-w-[760px]" : "max-w-[720px]")}>
      {label && (
        <label
          htmlFor="chat-composer-input"
          className="mb-2 block text-sm font-semibold text-foreground"
        >
          {label}
        </label>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <textarea
          ref={textareaRef}
          id="chat-composer-input"
          aria-label={label ?? "Start a chat"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter (and ⌘/Ctrl+Enter) keep a newline-friendly
            // path. A chat composer reads as "type and send".
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          placeholder="What are we working on?"
          spellCheck={false}
          rows={3}
          autoFocus
          className="block w-full resize-none bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2 border-t border-border py-2 pr-2 pl-2.5">
          <div className="flex min-w-0 items-center gap-1">
            {/* Combined harness + model picker: models grouped under their
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

          {/* Send — the primary one-click trigger. Black rounded square, up
              arrow, no text. */}
          <Button
            onClick={() => void start()}
            disabled={starting || prompt.trim() === ""}
            aria-label="Start chat"
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
          <p className="border-t border-border bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400/90">
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
    </div>
  );
}
