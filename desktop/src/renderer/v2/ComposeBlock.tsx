"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronUp,
  GaugeIcon,
  LoaderCircle,
  MonitorIcon,
  PencilIcon,
} from "lucide-react";

import {
  BUILTIN_PROMPT_IDS,
  BUILTIN_STARTING_PROMPTS,
  promptDescription,
} from "@/lib/chat";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { HitchClient } from "@/lib/server/client";
import {
  iconHarness,
  machineAvailability,
  modelLabelFor,
  modelsForHarness,
  reasoningLabelFor,
  reasoningOptionsFor,
  serverHarnessLabel,
  SERVER_HARNESSES,
  type ServerHarness,
} from "./delegation";
import {
  useDelegationComposer,
  type DelegateStartParams,
} from "./useDelegationComposer";

// The delegate band's compose half: machine selection + the composer + the
// controls that POST /assignments.
//
// Mounted ONLY while compose is expanded, which does two jobs at once — ⌘⏎ is
// armed exactly when there's a prompt on screen to fire (the arming lives in the
// composer hook), and adding a second agent starts from a clean composer instead
// of one still latched "submitted" from the previous launch.
//
// Prompt honesty: the textarea holds the WHOLE prompt as a template, and it is
// POSTed as `promptTemplate` untouched. Nothing is prepended, appended, or
// rewritten between here and the agent — the server's only edit is substituting
// $TASK_TITLE / $TASK_BODY / $TASK_ID, which is why the box can stay short
// without hiding anything. It does mean the source of truth for those variables
// is the tasks ROW, not React state, which opens a window the old spliced-preamble
// path didn't have: edits autosave on a ~1.5s idle debounce, so typing and hitting
// ⌘⏎ immediately would resolve $TASK_BODY against the PRE-EDIT row. Hence
// `flushTask` — delegation waits for the document to land before it POSTs.

export interface ComposeBlockProps {
  client: HitchClient;
  taskId: string;
  /** useTaskDocument's flush — awaited before every POST. */
  flushTask: () => Promise<void>;
  availability: ReturnType<typeof machineAvailability>;
  loadingMachines: boolean;
  /**
   * "Delegate" is the first hand-off of a task; once the lane holds a chat the
   * same button is ADDING an agent alongside the ones already there — it never
   * replaces or supersedes them, and the word has to say so.
   */
  primaryLabel: "Delegate" | "Add agent";
  onDelegated: () => void;
}

export function ComposeBlock({
  client,
  taskId,
  flushTask,
  availability,
  loadingMachines,
  primaryLabel,
  onDelegated,
}: ComposeBlockProps) {
  const queryClient = useQueryClient();

  // The chosen spawn target — default to the first usable machine, reconciled
  // whenever the usable set changes (a machine going offline, or the list
  // arriving).
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  useEffect(() => {
    const usable = availability.usable;
    if (usable.length === 0) {
      setSelectedMachineId(null);
      return;
    }
    setSelectedMachineId((prev) =>
      prev && usable.some((m) => m.id === prev) ? prev : usable[0].id,
    );
  }, [availability.usable]);

  const canDelegate =
    !loadingMachines &&
    availability.disabledReason === null &&
    selectedMachineId !== null;

  // POST /assignments — the textarea's text goes over the wire UNCHANGED as a
  // template; the server substitutes the task variables (server/src/prompt.ts).
  const onStart = useCallback(
    async ({ harness, model, effort, promptTemplate }: DelegateStartParams) => {
      if (!selectedMachineId) throw new Error("No machine selected");
      // Land any in-flight edit FIRST: the server resolves $TASK_TITLE /
      // $TASK_BODY from the row, so an unsaved keystroke would otherwise reach
      // the agent as the previous version of the task.
      await flushTask();
      const response = await client.assignments.$post({
        json: {
          taskId,
          machineId: selectedMachineId,
          harness,
          // Kickoff-only launch params; the daemon passes them to the launcher
          // argv. Null/undefined would fall back to the harness default, but the
          // compose UI always has a concrete selection.
          model,
          effort,
          promptTemplate,
          desiredState: "running",
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to delegate (${response.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["assignments"] });
      onDelegated();
    },
    [client, queryClient, selectedMachineId, taskId, flushTask, onDelegated],
  );

  const composer = useDelegationComposer({
    canStart: canDelegate,
    // Mounted == a prompt is on screen, so ⌘⏎ is armed for exactly as long as
    // there is something for it to send.
    keyboardArmed: true,
    onStart,
  });

  return (
    <ComposeControls
      composer={composer}
      machineControls={
        <MachinePicker
          availability={availability}
          loading={loadingMachines}
          selectedMachineId={selectedMachineId}
          onSelect={setSelectedMachineId}
        />
      }
      // While the machine list loads, the primary button is disabled but we
      // don't yet know WHY it might stay that way — so say what's happening
      // rather than rendering a dead button with no explanation. A slow or
      // retrying GET /machines can hold this for several seconds.
      disabledReason={
        loadingMachines ? "Checking for machines…" : availability.disabledReason
      }
      canDelegate={canDelegate}
      primaryLabel={primaryLabel}
    />
  );
}

// The machine picker: hidden with exactly one machine, disabled-with-hint when
// none/all stale (the hint is rendered by ComposeControls, not here). Shown
// only when more than one usable machine exists.
function MachinePicker({
  availability,
  loading,
  selectedMachineId,
  onSelect,
}: {
  availability: ReturnType<typeof machineAvailability>;
  loading: boolean;
  selectedMachineId: string | null;
  onSelect: (id: string) => void;
}) {
  if (loading || availability.hidePicker || availability.usable.length <= 1) {
    return null;
  }
  return (
    <>
      <span className="h-3.5 w-px shrink-0 bg-[#DEDEDE] dark:bg-border" aria-hidden />
      <Select
        value={selectedMachineId ?? undefined}
        onValueChange={(value) => onSelect(value as string)}
      >
        <SelectTrigger
          aria-label="Machine"
          className="h-7 gap-1.5 border-0 px-1.5 font-normal hover:bg-black/5"
        >
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue>
            {(value: string) => (
              <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
                {availability.usable.find((m) => m.id === value)?.name ??
                  "Machine"}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {availability.usable.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

// The compose affordance: preset row + expandable instruction textarea +
// agent/machine row ending in the primary button. Unchanged in behaviour by the
// lane — only the primary button's word moves (Delegate → Add agent) once the
// lane already holds a chat.
function ComposeControls({
  composer,
  machineControls,
  disabledReason,
  canDelegate,
  primaryLabel,
}: {
  composer: ReturnType<typeof useDelegationComposer>;
  machineControls: React.ReactNode;
  disabledReason: string | null;
  canDelegate: boolean;
  primaryLabel: "Delegate" | "Add agent";
}) {
  const [expanded, setExpanded] = useState(false);
  const chip = "h-7 gap-1.5 border-0 px-1.5 font-normal hover:bg-black/5";

  // A failed delegate used to be swallowed by `void composer.start()`: the
  // click did nothing, said nothing, and logged nothing. The message lives on
  // the composer so the ⌘⏎ path reports too; catching here only keeps the
  // rethrow from becoming an unhandled rejection.
  const onDelegateClick = useCallback(() => {
    void composer.start().catch((e: unknown) => {
      console.error("Failed to delegate", e);
    });
  }, [composer]);

  // Why the primary button is greyed out. Machine availability first (it's the
  // blocking one), then a blank prompt — which is otherwise a dead button with
  // no explanation, since the textarea is collapsed by default.
  //
  // Keyed on the prompt being blank, NOT on !canSubmit: canSubmit also folds in
  // machine availability, so the !canSubmit form told every cold start "Write a
  // prompt" while the textarea held the full default preset.
  const blockedReason =
    disabledReason ??
    (composer.prompt.trim() === "" ? "Write a prompt to delegate." : null);

  return (
    <>
      {/* Preset row */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Select
            value={composer.promptId}
            onValueChange={(value) => composer.choosePreset(value as string)}
          >
            <SelectTrigger
              aria-label="Starting prompt"
              className="h-6.5 shrink-0 gap-1 rounded-sm border border-[#DEDEDE] bg-white px-2 text-[12.5px] font-semibold text-[#2E2E2E] hover:bg-white/70 dark:border-border dark:bg-background dark:text-foreground"
            >
              <SelectValue>
                {(value: string) =>
                  composer.prompts.find((p) => p.id === value)?.name ??
                  "Select a prompt"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {composer.prompts
                .filter((p) => BUILTIN_PROMPT_IDS.has(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              {composer.prompts.some((p) => !BUILTIN_PROMPT_IDS.has(p.id)) && (
                <>
                  <div className="my-1 h-px bg-border" />
                  {composer.prompts
                    .filter((p) => !BUILTIN_PROMPT_IDS.has(p.id))
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </>
              )}
            </SelectContent>
          </Select>
          <span className="truncate text-[12.5px] text-[#717171] dark:text-muted-foreground">
            {promptDescription(
              composer.prompts.find((p) => p.id === composer.promptId) ??
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

      {/* The one-off editable prompt template — the entire text the agent gets
          (never written back to the preset). */}
      {expanded && (
        <textarea
          aria-label="Delegation prompt"
          value={composer.prompt}
          onChange={(e) => composer.setPrompt(e.target.value)}
          spellCheck={false}
          // Tall enough to show a whole default template without scrolling: the
          // framing alone is 6 lines before the instruction, and a box that cut
          // off the instruction would recreate the problem templates fixed.
          rows={11}
          autoFocus
          className="max-h-[45vh] w-full resize-none overflow-y-auto rounded-md border border-[#E4E4E4] bg-white px-3 py-2 font-mono text-xs leading-relaxed outline-none dark:border-border dark:bg-background"
        />
      )}

      {/* Agent row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {/* Combined harness + model picker: models are grouped under their
              harness, so choosing a model also fixes the harness. Picking a
              model routes through chooseAgent so effort resets to its default. */}
          <Select
            value={`${composer.harness}|${composer.model}`}
            onValueChange={(value) => composer.chooseAgent(value as string)}
          >
            <SelectTrigger aria-label="Agent and model" className={chip}>
              <SelectValue>
                {(value: string) => {
                  const sep = value.indexOf("|");
                  const h = value.slice(0, sep) as ServerHarness;
                  const m = value.slice(sep + 1);
                  return (
                    <span className="flex items-center gap-1.5">
                      <HarnessIcon harness={iconHarness(h)} className="size-3.5" />
                      <span className="text-[13px] font-medium text-[#222222] dark:text-foreground">
                        {serverHarnessLabel(h)}
                      </span>
                      <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
                        {modelLabelFor(h, m)}
                      </span>
                    </span>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SERVER_HARNESSES.map((h) => (
                <Fragment key={h}>
                  <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                    <HarnessIcon harness={iconHarness(h)} className="size-3.5" />
                    {serverHarnessLabel(h)}
                  </div>
                  {modelsForHarness(h).map((mm) => (
                    <SelectItem
                      key={`${h}|${mm.id}`}
                      value={`${h}|${mm.id}`}
                      className="pl-7"
                    >
                      {mm.label}
                    </SelectItem>
                  ))}
                </Fragment>
              ))}
            </SelectContent>
          </Select>

          <span className="h-4 w-px shrink-0 bg-border" aria-hidden />

          {/* Reasoning/effort — harness+model specific. Always enabled in V2:
              the reconciler spawns into cmux, which honors launch params. */}
          <Select
            value={composer.effort}
            onValueChange={(value) => composer.setEffort(value as string)}
          >
            <SelectTrigger aria-label="Reasoning effort" className={chip}>
              <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue>
                {(value: string) => (
                  <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
                    {reasoningLabelFor(composer.harness, value, composer.model)}
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {reasoningOptionsFor(composer.harness, composer.model).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {machineControls}
        </div>

        {/* The primary — black, text + embedded ⌘⏎ chip (mirrors V1's Start). */}
        <button
          type="button"
          onClick={onDelegateClick}
          disabled={composer.phase !== "idle" || !canDelegate || !composer.canSubmit}
          aria-label={primaryLabel}
          className="flex h-8 shrink-0 items-center gap-1.75 rounded-md bg-[#0B0B0B] px-3 text-white disabled:opacity-40 dark:bg-foreground dark:text-background"
        >
          {composer.phase !== "idle" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <>
              <span className="text-[13px] font-semibold">{primaryLabel}</span>
              <Kbd className="border border-white/20 bg-white/15 text-white/85 dark:border-background/20 dark:bg-background/15 dark:text-background/85">
                ⌘⏎
              </Kbd>
            </>
          )}
        </button>
      </div>

      {blockedReason && (
        <p className="text-[12px] text-muted-foreground">{blockedReason}</p>
      )}
      {composer.error && (
        <p className="text-[12px] text-destructive">{composer.error}</p>
      )}
    </>
  );
}
