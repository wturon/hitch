"use client";

import { Fragment, useState } from "react";
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
  chatActivity,
  environmentLabel,
  harnessLabel,
  modelLabel,
  promptDescription,
  reasoningLabel,
  reasoningOptions,
  type ChatActivity,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
  type DelegationRequest,
  type Harness,
} from "@/lib/chat";
import {
  MANAGE_PROMPTS_VALUE,
  useDelegationComposer,
} from "@/hooks/useDelegationComposer";
import { HarnessIcon } from "@/components/HarnessIcon";
import { ChatLaunch } from "@/components/ChatLaunch";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
//
// The compose STATE MACHINE (agent seeding + persistence, prompt preset
// loading/selection, effort defaults, launch-param honoring, the start latch,
// and the global ⌘⏎ arming) lives in the shared useDelegationComposer; this
// component is only the band's chrome over it. The todo dialog's docked footer
// renders different chrome over the same hook.
export function DelegationBand({
  projectId,
  chat,
  chatStatus,
  chatOpenState,
  request,
  title,
  path,
  canDelegate = true,
  onStart,
  onClear,
  onManagePrompts,
  onManageHarnesses,
}: {
  projectId: Id<"projects">;
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  chatOpenState: ChatOpenState | null;
  // The pre-link summoning flag (requested / failed). Present only when a launch
  // is in flight or failed and no real chat has bound yet.
  request: DelegationRequest | null;
  title: string;
  path: string;
  // Whether the task can be delegated right now. A new draft with no title has
  // no slug/file to launch against, so Send and ⌘↩ stay inert until it's typed.
  canDelegate?: boolean;
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
  // The shared compose model. ⌘⏎ arms only while the band is in its compose
  // state (no chat linked, no launch in flight) and the task is delegable; the
  // hook's phase latch closes the double-fire window on top of that.
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
    canStart: canDelegate,
    keyboardArmed: !chat && !request && canDelegate,
    onStart,
    onManagePrompts,
  });
  // Whether the prompt editor is revealed. Minimized is the default calm state
  // — pure chrome, so it lives here rather than in the composer.
  const [expanded, setExpanded] = useState(false);

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

  // A delegation is in flight or failed but no chat has bound yet. Mirror the
  // linked layout so the band doesn't jump, but with the requested harness and a
  // status word in place of the live controls. Failed offers Clear (start over).
  if (request) {
    const failed = request.state === "failed";
    return (
      <div
        className={cn(
          surface,
          "flex items-center justify-between gap-2 py-2.5 pr-2.5 pl-3.5",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <HarnessIcon
            harness={request.harness}
            className={cn("size-5 shrink-0", !failed && "opacity-60")}
          />
          <span className="truncate text-sm font-semibold">
            {harnessLabel(request.harness)}
          </span>
          {failed ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {request.error?.trim() || "Couldn’t start"}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Summoning…
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
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

        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {/* Send — the primary one-click trigger. Black rounded square, up-arrow,
              no text. `phase !== "idle"` covers both the in-flight mutation and
              the post-submit latch (exactly the old sending/submitted pair). */}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
              <Button
                onClick={start}
                disabled={phase !== "idle" || !canDelegate}
                aria-label="Delegate to agent"
                className="size-8 shrink-0 rounded-lg p-0"
              >
                {phase !== "idle" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {canDelegate ? (
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <Kbd>Enter</Kbd>
                </KbdGroup>
              ) : (
                "Add a title to delegate"
              )}
            </TooltipContent>
          </Tooltip>
        </div>
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
