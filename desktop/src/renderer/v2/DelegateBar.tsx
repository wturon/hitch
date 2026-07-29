"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ChevronRight,
  ChevronUp,
  GaugeIcon,
  LoaderCircle,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
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
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import {
  chatAgentDetail,
  chatStatusLine,
  composeStartsExpanded,
  deadLaunchNotice,
  earlierChatsLabel,
  laneCountLabel,
  laneRowAction,
  laneSpansMachines,
  primaryActionLabel,
  showsStopAll,
} from "./chatLane";
import {
  assignmentsToStopOnDone,
  machineAvailability,
  modelLabelFor,
  modelsForHarness,
  reasoningLabelFor,
  reasoningOptionsFor,
  serverHarnessLabel,
  SERVER_HARNESSES,
  type ServerHarness,
} from "./delegation";
import { StaticHarnessChip } from "./HarnessChip";
import { chatsForTask, partitionLaneChats, type TaskChat } from "./todoGroups";
import { useAssignments, useMachines, type AssignmentRow } from "./useAssignments";
import { useOpenChat } from "./useOpenChat";
import {
  useDelegationComposerV2,
  type DelegateStartParams,
} from "./useDelegationComposerV2";

// The delegate band in TaskDialogV2's saved stage — the task's CHAT LANE plus a
// compose block, in that order.
//
// It used to be a one-slot bar: `selectLatestAssignment` + `deriveBarState` folded
// the task's whole assignment history down to its newest row and rendered one of
// three states (compose / active / re-delegate). A task can carry SEVERAL live
// chats at once (assignments are append-only and POST /assignments has no
// one-live-per-task guard), so that fold made every other agent on the task
// invisible: a second agent blocked on the user simply wasn't on screen, and
// "Stop" ended whichever one happened to be newest. Both derivations are gone.
//
//   lane     — one row per chat still IN PLAY (needs-you / working), in the order
//              chatsForTask returns (attention band first, newest first inside a
//              band). Each row: the harness avatar with its status ring, the
//              agent + launch params, an honest status + age, and the actions
//              that belong to THAT chat (Open chat, Stop, or Reviewed).
//   earlier  — finished-and-acked chats collapse behind an "N earlier chats"
//              disclosure. They keep Open chat (the chat still exists and cmux
//              can bring it back) and lose Stop (there is nothing to stop).
//   compose  — the unchanged compose controls. Expanded by default only when
//              nothing is in play (a fresh task, or one whose chats have all
//              finished), so the common case keeps its old ergonomics; otherwise
//              it collapses to a "＋ Add an agent" ghost button, because the
//              lane — not the composer — is what the user came to read.
//
// Every ordering/visibility/wording rule is a pure function: the lane's shape in
// todoGroups (slice 1), everything it SAYS in chatLane. This file is the wiring.
//
// Prompt honesty: the textarea holds the WHOLE prompt as a template, and it is
// POSTed as `promptTemplate` untouched. Nothing is prepended, appended, or
// rewritten between here and the agent — the server's only edit is substituting
// $TASK_TITLE / $TASK_BODY / $TASK_ID, which is why the box can stay short
// without hiding anything.
// The bar no longer takes the task's title/body: it used to splice them into a
// preamble here, but the prompt is a template now and the server substitutes
// them from the tasks ROW at creation time.
//
// That moves the source of truth from React state to the database, which opens
// a window the old path didn't have: edits are autosaved on a ~1.5s idle
// debounce, so typing and hitting ⌘⏎ immediately would resolve $TASK_BODY
// against the PRE-EDIT row. Hence `flushTask` — delegation waits for the
// document to land before it POSTs.
export interface DelegateBarProps {
  client: HitchClient;
  // The committed task id (the bar mounts only once the row exists).
  taskId: string;
  // useTaskDocument's flush: persists any dirty title/body now. Awaited before
  // every delegate so the server resolves the prompt against what's on screen.
  flushTask: () => Promise<void>;
}

// Map the V2 server harness (claude|codex) onto V1's HarnessIcon prop
// (claude-code|codex) — the icon component predates the server enum.
function iconHarness(harness: ServerHarness): "claude-code" | "codex" {
  return harness === "codex" ? "codex" : "claude-code";
}

// The client-writable half of PATCH /assignments/:id (server validation.ts:
// assignmentClientUpdate). observed_state / chat_id are daemon-only.
type AssignmentPatch = { desiredState: "stopped" } | { reviewedAt: string };

export function DelegateBar({ client, taskId, flushTask }: DelegateBarProps) {
  const queryClient = useQueryClient();
  const assignmentsQuery = useAssignments(client, taskId);
  const machinesQuery = useMachines(client);

  // One slow clock for the whole band: machine staleness AND the rows' ages
  // (both are minute-coarse, so 30s is enough resolution) advance without
  // needing a refetch, so a dialog left open doesn't freeze at "started 1m ago".
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const availability = useMemo(
    () => machineAvailability(machinesQuery.data, nowTick),
    [machinesQuery.data, nowTick],
  );
  const loadingMachines = machinesQuery.isPending;

  // The lane. Order and the visible/earlier split are slice 1's derivation —
  // nothing here picks a "latest".
  const chats = useMemo(
    () => chatsForTask(assignmentsQuery.data, taskId),
    [assignmentsQuery.data, taskId],
  );
  const { visible, earlier } = useMemo(() => partitionLaneChats(chats), [chats]);

  // Machine chrome only when the lane actually spans machines; one machine is the
  // norm and naming it on every row says nothing. Read over the WHOLE lane
  // (visible + earlier) so expanding the disclosure can't relabel an earlier
  // chat's machine as this one.
  const showMachines = laneSpansMachines(chats);
  const machineNames = useMemo(
    () => new Map((machinesQuery.data ?? []).map((m) => [m.id, m.name] as const)),
    [machinesQuery.data],
  );
  const machineNameFor = (chat: TaskChat<AssignmentRow>) =>
    showMachines ? (machineNames.get(chat.assignment.machineId) ?? null) : null;

  // Stop-all's target set is close-on-done's ("live and not terminal") — one
  // predicate, not a second one that could drift from it.
  const stoppableIds = useMemo(
    () => assignmentsToStopOnDone(assignmentsQuery.data, taskId),
    [assignmentsQuery.data, taskId],
  );
  const [stoppingAll, setStoppingAll] = useState(false);
  const stopAll = useCallback(async () => {
    setStoppingAll(true);
    try {
      await Promise.all(
        stoppableIds.map(async (id) => {
          const response = await client.assignments[":id"].$patch({
            param: { id },
            json: { desiredState: "stopped" },
          });
          if (!response.ok) {
            throw new Error(`Failed to stop assignment (${response.status})`);
          }
        }),
      );
    } catch (error) {
      console.error("Failed to stop every chat", error);
    } finally {
      // Refetch either way: a partial failure still stopped some of them, and
      // the lane must show what actually happened.
      await queryClient.invalidateQueries({ queryKey: ["assignments"] });
      setStoppingAll(false);
    }
  }, [client, queryClient, stoppableIds]);

  // Compose's expansion. `null` = "the lane decides" (see composeStartsExpanded);
  // clicking ＋ Add an agent pins it open. A successful delegate hands the
  // decision back to the lane, so the block folds away and the new chat's row is
  // what the user sees next.
  const [composeOverride, setComposeOverride] = useState<boolean | null>(null);
  const composeExpanded = composeOverride ?? composeStartsExpanded(visible.length);

  // Bumped on every successful delegate to KEY the compose block, so the next
  // "Add an agent" always gets a fresh composer. Collapsing already unmounts it,
  // but that only happens if the refetched lane came back non-empty: a failed or
  // stale-empty refetch would otherwise leave compose mounted around a composer
  // latched at phase "submitted" — a permanently disabled button with a spinner
  // until the dialog is reopened. The key closes that hole structurally.
  const [launchSeq, setLaunchSeq] = useState(0);

  const [earlierOpen, setEarlierOpen] = useState(false);

  // A launch that never started (see deadLaunchNotice): the lane drops `dead`
  // assignments, so without this the failure would be silent.
  const deadNotice = deadLaunchNotice(assignmentsQuery.data, taskId, visible.length);

  const countLabel = laneCountLabel(visible.length);
  const rowsClass = "flex flex-col divide-y divide-[#EDEDED] dark:divide-border/60";

  const bandClass =
    "flex flex-col gap-2.5 rounded-b-xl border-t border-t-[#E8E8E8] bg-[#F9F9F9] px-5 pt-3 pb-3.5 dark:border-t-border dark:bg-muted/40";

  // Nothing is asserted until the first read lands: an un-settled query makes the
  // lane read as EMPTY, and rendering compose off that would tell a task with
  // three live agents that it has none — then jump. `data !== undefined` (not
  // !isPending) so a later refetch never blanks a band that's already up.
  if (assignmentsQuery.data === undefined) {
    return <div className={bandClass} data-testid="v2-delegate-band-loading" />;
  }

  return (
    <div className={bandClass}>
      {countLabel && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-[#717171] dark:text-muted-foreground">
            {countLabel}
          </span>
          {/* Stop all — shown only once there is a bulk to act on (2+ chats
              would be stopped).

              NEUTRAL at rest, like every other ghost control in the band. Red is
              this system's DANGER colour, not its "affects several rows" colour,
              and a secondary bulk control rendered in it was the loudest pixel in
              the dialog — louder than the task's own text, and far louder than the
              per-row Stop buttons that do the same thing with a smaller blast
              radius. Amber is the only voice allowed to be raised here. The
              destructive tone arrives on hover/focus, where the user is already
              committing to it. */}
          {showsStopAll(stoppableIds) && (
            <button
              type="button"
              onClick={() => void stopAll()}
              disabled={stoppingAll}
              className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-[#717171] hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none disabled:opacity-60 dark:text-muted-foreground"
            >
              {stoppingAll && <LoaderCircle className="size-3 animate-spin" />}
              Stop all
            </button>
          )}
        </div>
      )}

      {visible.length > 0 && (
        <div className={rowsClass}>
          {visible.map((chat) => (
            <LaneRow
              key={chat.assignment.id}
              client={client}
              chat={chat}
              machineName={machineNameFor(chat)}
              now={nowTick}
            />
          ))}
        </div>
      )}

      {earlier.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setEarlierOpen((v) => !v)}
            aria-expanded={earlierOpen}
            className="flex h-6.5 w-fit items-center gap-1 rounded-md px-1 text-[12px] font-medium text-[#717171] hover:bg-black/5 dark:text-muted-foreground dark:hover:bg-white/5"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform motion-reduce:transition-none",
                earlierOpen && "rotate-90",
              )}
              aria-hidden
            />
            {earlierChatsLabel(earlier.length)}
          </button>
          {earlierOpen && (
            <div className={rowsClass}>
              {earlier.map((chat) => (
                <LaneRow
                  key={chat.assignment.id}
                  client={client}
                  chat={chat}
                  machineName={machineNameFor(chat)}
                  now={nowTick}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Compose. A hairline separates it from the lane above rather than a
          second surface — the band stays one flat plane. */}
      <div
        className={cn(
          "flex flex-col gap-2.5",
          chats.length > 0 && "border-t border-[#EDEDED] pt-2.5 dark:border-border/60",
        )}
      >
        {/* The launch that never started: one muted line, no chip, no row, no
            amber. It's a fact about the last attempt, not a state to act on. */}
        {deadNotice && (
          <p className="text-[12px] text-[#717171] dark:text-muted-foreground">
            {deadNotice}
          </p>
        )}
        {composeExpanded ? (
          <ComposeBlock
            // A fresh composer per successful launch — see launchSeq.
            key={launchSeq}
            client={client}
            taskId={taskId}
            flushTask={flushTask}
            availability={availability}
            loadingMachines={loadingMachines}
            primaryLabel={primaryActionLabel(visible.length)}
            onDelegated={() => {
              setComposeOverride(null);
              setLaunchSeq((n) => n + 1);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setComposeOverride(true)}
            className="flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-[#555555] hover:bg-black/5 dark:text-muted-foreground dark:hover:bg-white/5"
          >
            <PlusIcon className="size-3.5" aria-hidden />
            Add an agent
          </button>
        )}
      </div>
    </div>
  );
}

// One chat in the lane. Everything it renders is about THIS assignment: the
// avatar's ring state, the launch params, the age, and the actions — so Stop can
// no longer hit the wrong agent, which was the whole point of the slice.
function LaneRow({
  client,
  chat,
  machineName,
  now,
}: {
  client: HitchClient;
  chat: TaskChat<AssignmentRow>;
  /** The resolved machine name, or null when the lane doesn't name machines. */
  machineName: string | null;
  /** The band's shared clock, so every row's age ticks together. */
  now: number;
}) {
  const queryClient = useQueryClient();
  const { assignment, state } = chat;
  const [busy, setBusy] = useState(false);
  // Open chat: the shared focus relay, addressed to THIS chat. Disabled until
  // the daemon has linked one (chatId is written at spawn), which is also the
  // window where cmux has nothing to focus.
  const { canOpen, openChat } = useOpenChat(assignment);
  const action = laneRowAction(assignment);

  const patch = useCallback(
    async (json: AssignmentPatch) => {
      setBusy(true);
      try {
        const response = await client.assignments[":id"].$patch({
          param: { id: assignment.id },
          json,
        });
        if (!response.ok) {
          throw new Error(`Failed to update assignment (${response.status})`);
        }
        await queryClient.invalidateQueries({ queryKey: ["assignments"] });
      } catch (error) {
        console.error("Failed to update assignment", error);
      } finally {
        setBusy(false);
      }
    },
    [assignment.id, client, queryClient],
  );

  return (
    <div data-testid="v2-chat-lane-row" className="flex items-center gap-2.5 py-2">
      {/* The row's instrument, borrowed whole from the todo row's chip so the two
          surfaces can't drift: brand mark inside, status in the ring, amber dot
          for needs-you. Static — the actions are their own controls here. */}
      <StaticHarnessChip harness={assignment.harness} state={state} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-[13px] font-medium text-[#222222] dark:text-foreground">
            {serverHarnessLabel(assignment.harness)}
          </span>
          <span className="truncate text-[12.5px] text-[#717171] dark:text-muted-foreground">
            {chatAgentDetail(assignment)}
          </span>
          {machineName !== null && (
            <span className="shrink-0 text-[12.5px] text-[#717171] dark:text-muted-foreground">
              on {machineName}
            </span>
          )}
        </div>
        {/* Status + age, always neutral: needs-you's amber is the chip's ring +
            dot, and ONE amber mark per row is the whole point of that treatment.
            (The V1 chip's amber status TEXT came off for the same reason when the
            ring came back — see HarnessChip.) */}
        <span
          data-testid="v2-delegate-chip"
          data-chip-state={state}
          className="truncate text-[12px] text-[#717171] dark:text-muted-foreground"
        >
          {chatStatusLine(assignment, now)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={openChat}
                disabled={!canOpen}
                aria-label="Open chat"
                className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-black/5 disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent dark:hover:bg-white/5"
              />
            }
          >
            <ArrowUpRight className="size-3.5" />
            Open chat
          </TooltipTrigger>
          <TooltipContent>
            {canOpen
              ? "Bring the chat forward in cmux"
              : "Waiting for the agent's chat to start…"}
          </TooltipContent>
        </Tooltip>
        {action !== "none" && (
          <button
            type="button"
            onClick={() =>
              void patch(
                action === "stop"
                  ? { desiredState: "stopped" }
                  : { reviewedAt: new Date().toISOString() },
              )
            }
            disabled={busy}
            className="flex h-8 items-center rounded-md border border-[#DEDEDE] px-3 text-[13px] font-medium text-foreground hover:bg-black/5 disabled:opacity-60 dark:border-border dark:hover:bg-white/5"
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : action === "stop" ? (
              "Stop"
            ) : (
              // The same words as the list row's context menu: one action, one
              // name, and a control that says what happens rather than a state.
              "Mark reviewed"
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// The compose block: machine selection + the composer + the controls. Mounted
// ONLY while compose is expanded, which does two jobs at once — ⌘⏎ is armed
// exactly when there's a prompt on screen to fire (the arming lives in the
// composer hook), and adding a second agent starts from a clean composer instead
// of one still latched "submitted" from the previous launch.
function ComposeBlock({
  client,
  taskId,
  flushTask,
  availability,
  loadingMachines,
  primaryLabel,
  onDelegated,
}: {
  client: HitchClient;
  taskId: string;
  flushTask: () => Promise<void>;
  availability: ReturnType<typeof machineAvailability>;
  loadingMachines: boolean;
  primaryLabel: "Delegate" | "Add agent";
  onDelegated: () => void;
}) {
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

  const composer = useDelegationComposerV2({
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
  composer: ReturnType<typeof useDelegationComposerV2>;
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
