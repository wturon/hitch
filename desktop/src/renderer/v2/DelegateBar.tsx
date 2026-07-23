"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ChevronUp,
  CircleAlertIcon,
  CircleCheckIcon,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getHitchServerBridge } from "@/lib/server/bridge";
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import {
  composeDelegatePrompt,
  deriveBarState,
  machineAvailability,
  modelLabelFor,
  modelsForHarness,
  observedStateChip,
  reasoningLabelFor,
  reasoningOptionsFor,
  selectLatestAssignment,
  serverHarnessLabel,
  SERVER_HARNESSES,
  type ChipInfo,
  type ServerHarness,
} from "./delegation";
import { useAssignments, useMachines } from "./useAssignments";
import {
  useDelegationComposerV2,
  type DelegateStartParams,
} from "./useDelegationComposerV2";

// The floating delegate bar in TaskDialogV2's saved stage (M4 PR 5, option L).
// Three states derived from the task's assignment history + the machine list:
//
//   compose      — no assignment yet: agent picker (claude|codex, seeded from
//                  the last delegation), machine picker (hidden with exactly one
//                  machine, disabled-with-hint when none/all stale), a
//                  starting-prompt preset dropdown + a collapsed editable
//                  instruction textarea, and ⌘⏎ = delegate-with-defaults.
//   active       — a live assignment (latest, observed_state ∉ {done,dead}): a
//                  status chip (Spawning… / Working / Needs you), an Open chat
//                  seam (disabled this PR — focus lands in PR 6), and Stop.
//   re-delegate  — the latest assignment finished (done|dead): the outcome shown
//                  subtly, then the compose affordance again (history is
//                  preserved server-side; no history UI this PR).
//
// Prompt composition (Decision 2): the final prompt POSTed is the machine-facing
// preamble (task title + body verbatim + id + `hitch` CLI line) followed by the
// chosen instruction — stamped VERBATIM into assignments.prompt.
export interface DelegateBarProps {
  client: HitchClient;
  // The committed task id (the bar mounts only once the row exists).
  taskId: string;
  // The live document fields, so the preamble embeds the CURRENT title/body at
  // delegate time (composed on click, not at mount).
  title: string;
  body: string;
}

// Map the V2 server harness (claude|codex) onto V1's HarnessIcon prop
// (claude-code|codex) — the icon component predates the server enum.
function iconHarness(harness: ServerHarness): "claude-code" | "codex" {
  return harness === "codex" ? "codex" : "claude-code";
}

export function DelegateBar({ client, taskId, title, body }: DelegateBarProps) {
  const queryClient = useQueryClient();
  const assignmentsQuery = useAssignments(client, taskId);
  const machinesQuery = useMachines(client);

  const latest = selectLatestAssignment(assignmentsQuery.data);
  const barState = deriveBarState(latest);

  // Re-evaluate machine staleness on a slow tick so a machine that goes quiet
  // while the dialog is open drops to "offline" without needing a refetch.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const availability = useMemo(
    () => machineAvailability(machinesQuery.data, nowTick),
    [machinesQuery.data, nowTick],
  );

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

  const loadingMachines = machinesQuery.isPending;
  const canDelegate =
    !loadingMachines &&
    availability.disabledReason === null &&
    selectedMachineId !== null;

  // POST /assignments — the composed prompt is built here (current title/body).
  const onStart = useCallback(
    async ({ harness, model, effort, prompt }: DelegateStartParams) => {
      if (!selectedMachineId) throw new Error("No machine selected");
      const composed = composeDelegatePrompt({ id: taskId, title, body }, prompt);
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
          prompt: composed,
          desiredState: "running",
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to delegate (${response.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
    [client, queryClient, selectedMachineId, taskId, title, body],
  );

  const composer = useDelegationComposerV2({
    canStart: canDelegate,
    // Arm ⌘⏎ only where a compose affordance is showing (not in the active
    // state, which has no prompt to fire).
    keyboardArmed: barState !== "active",
    onStart,
  });

  // Stop a live assignment (PATCH desired_state=stopped; the reconciler closes
  // the tab and writes observed_state=done).
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(async () => {
    if (!latest) return;
    setStopping(true);
    try {
      const response = await client.assignments[":id"].$patch({
        param: { id: latest.id },
        json: { desiredState: "stopped" },
      });
      if (!response.ok) {
        throw new Error(`Failed to stop assignment (${response.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["assignments"] });
    } catch (error) {
      console.error("Failed to stop assignment", error);
    } finally {
      setStopping(false);
    }
  }, [client, queryClient, latest]);

  // Open chat (M4 PR 6): relay a focus EVENT to the assignment's machine — the
  // ephemeral half of the two-forms model (PRD). client → main-held WS → server
  // relay → daemon → cmux openChat + activateApp. Fire-and-forget: an
  // undelivered event just evaporates (~30s reconcile never touches focus).
  // Enabled once the daemon has linked a chat (chatId set at spawn).
  const canOpenChat = latest?.chatId != null && latest?.machineId != null;
  const openChat = useCallback(() => {
    if (!latest?.chatId || !latest.machineId) return;
    void getHitchServerBridge()?.wsSend({
      type: "event",
      event: "focus",
      machineId: latest.machineId,
      payload: { chatId: latest.chatId },
    });
  }, [latest]);

  const bandClass =
    "flex flex-col gap-2.5 rounded-b-xl border-t border-t-[#E8E8E8] bg-[#F9F9F9] px-5 pt-3 pb-3.5 dark:border-t-border dark:bg-muted/40";

  // ─── active ────────────────────────────────────────────────────────────────
  if (barState === "active" && latest) {
    const chip = observedStateChip(latest.observedState);
    return (
      <div className={bandClass}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <HarnessIcon
              harness={iconHarness(latest.harness)}
              className="size-4 shrink-0"
            />
            <StatusChip info={chip} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Open chat — relays a focus event to the assignment's machine;
                the daemon focuses (or resumes) the cmux tab and raises the app.
                Disabled until the daemon has linked a chat (chatId set). */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={openChat}
                    disabled={!canOpenChat}
                    aria-label="Open chat"
                    className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-black/5 disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent dark:hover:bg-white/5"
                  />
                }
              >
                <ArrowUpRight className="size-3.5" />
                Open chat
              </TooltipTrigger>
              <TooltipContent>
                {canOpenChat
                  ? "Bring the chat forward in cmux"
                  : "Waiting for the agent's chat to start…"}
              </TooltipContent>
            </Tooltip>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping}
              className="flex h-8 items-center rounded-md border border-[#DEDEDE] px-3 text-[13px] font-medium text-foreground hover:bg-black/5 disabled:opacity-60 dark:border-border dark:hover:bg-white/5"
            >
              {stopping ? <LoaderCircle className="size-3.5 animate-spin" /> : "Stop"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── re-delegate & compose ───────────────────────────────────────────────────
  return (
    <div className={bandClass}>
      {barState === "re-delegate" && latest && (
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <OutcomeGlyph info={observedStateChip(latest.observedState)} />
          <span>
            {latest.observedState === "done"
              ? "The last agent finished."
              : "The last agent didn’t start."}{" "}
            Delegate again below.
          </span>
        </div>
      )}
      <ComposeControls
        composer={composer}
        machineControls={
          <MachinePicker
            client={client}
            availability={availability}
            loading={loadingMachines}
            selectedMachineId={selectedMachineId}
            onSelect={setSelectedMachineId}
          />
        }
        disabledReason={loadingMachines ? null : availability.disabledReason}
        canDelegate={canDelegate}
      />
    </div>
  );
}

// The status chip (active state). Monochrome except needs-you, which uses the
// existing amber NEEDS-YOU treatment (a dot + amber text), never a fill.
function StatusChip({ info }: { info: ChipInfo }) {
  if (info.tone === "needs-you") {
    return (
      <span
        data-testid="v2-delegate-chip"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-amber-700 dark:text-amber-500/90"
      >
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
        {info.label}
      </span>
    );
  }
  const spinning = info.tone === "spawning" || info.tone === "working";
  return (
    <span
      data-testid="v2-delegate-chip"
      className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground"
    >
      {spinning ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      ) : info.tone === "done" ? (
        <CircleCheckIcon className="size-3.5" aria-hidden />
      ) : (
        <CircleAlertIcon className="size-3.5" aria-hidden />
      )}
      {info.label}
    </span>
  );
}

// The small outcome glyph on the re-delegate line.
function OutcomeGlyph({ info }: { info: ChipInfo }) {
  return info.tone === "done" ? (
    <CircleCheckIcon className="size-3.5 shrink-0" aria-hidden />
  ) : (
    <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
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
  client: HitchClient;
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

// The compose affordance shared by the compose and re-delegate states: preset
// row + expandable instruction textarea + agent/machine row ending in Delegate.
function ComposeControls({
  composer,
  machineControls,
  disabledReason,
  canDelegate,
}: {
  composer: ReturnType<typeof useDelegationComposerV2>;
  machineControls: React.ReactNode;
  disabledReason: string | null;
  canDelegate: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const chip = "h-7 gap-1.5 border-0 px-1.5 font-normal hover:bg-black/5";

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

      {/* The one-off editable instruction (never written back to the preset). */}
      {expanded && (
        <textarea
          aria-label="Delegation instructions"
          value={composer.prompt}
          onChange={(e) => composer.setPrompt(e.target.value)}
          spellCheck={false}
          rows={6}
          autoFocus
          className="w-full resize-none rounded-md border border-[#E4E4E4] bg-white px-3 py-2 font-mono text-xs leading-relaxed outline-none dark:border-border dark:bg-background"
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

        {/* Delegate — black, text + embedded ⌘⏎ chip (mirrors V1's Start). */}
        <button
          type="button"
          onClick={() => void composer.start()}
          disabled={composer.phase !== "idle" || !canDelegate}
          aria-label="Delegate"
          className="flex h-8 shrink-0 items-center gap-1.75 rounded-md bg-[#0B0B0B] px-3 text-white disabled:opacity-40 dark:bg-foreground dark:text-background"
        >
          {composer.phase !== "idle" ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <>
              <span className="text-[13px] font-semibold">Delegate</span>
              <Kbd className="border border-white/20 bg-white/15 text-white/85 dark:border-background/20 dark:bg-background/15 dark:text-background/85">
                ⌘⏎
              </Kbd>
            </>
          )}
        </button>
      </div>

      {disabledReason && (
        <p className="text-[12px] text-muted-foreground">{disabledReason}</p>
      )}
    </>
  );
}
