"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  BotIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ClockIcon,
  CornerDownLeftIcon,
  EllipsisIcon,
  GaugeIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  Trash2Icon,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import {
  automationFileForPath,
  defaultAutomationDraft,
  draftFromContent,
  localTimezone,
  type AutomationDefinitionDraft,
  type AutomationFileDoc,
  type AutomationRecord,
  type AutomationRunRecord,
} from "@/lib/automations";
import {
  DAY_NAMES,
  cronFromBuilder,
  scheduleBuilderFromCron,
  scheduleHelper,
  type ScheduleBuilderValue,
  type ScheduleCadence,
} from "@/lib/automationSchedules";
import { useChatActions } from "@/hooks/useChats";
import {
  useAutomationActions,
  useAutomationDefinitions,
  useAutomationRuns,
} from "@/hooks/useAutomations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HarnessIcon } from "@/components/HarnessIcon";
import { cn } from "@/lib/utils";

function relativeTime(ts: number | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 14 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

type AutomationStatusRun = AutomationRunRecord | NonNullable<AutomationRecord["lastRun"]>;

const CADENCE_LABELS: Record<ScheduleCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  weekdays: "Every weekday",
  hourly: "Hourly",
  custom: "Custom cron",
};

function twoDigit(value: number) {
  return String(value).padStart(2, "0");
}

function clampNumber(value: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function timeValue(value: ScheduleBuilderValue) {
  return `${twoDigit(value.hour)}:${twoDigit(value.minute)}`;
}

function ScheduleBuilder({
  value,
  onChange,
  compact = false,
}: {
  value: ScheduleBuilderValue;
  onChange: (value: ScheduleBuilderValue) => void;
  compact?: boolean;
}) {
  const helper = scheduleHelper(value);
  const update = (patch: Partial<ScheduleBuilderValue>) =>
    onChange({ ...value, ...patch });

  return (
    <div className={cn("grid gap-3", compact ? "text-sm" : undefined)}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
          Cadence
          <Select
            value={value.cadence}
            onValueChange={(nextValue) => update({ cadence: nextValue as ScheduleCadence })}
          >
            <SelectTrigger className="h-9 bg-background">
              <SelectValue>
                {(selected: ScheduleCadence) => CADENCE_LABELS[selected]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CADENCE_LABELS).map(([cadence, label]) => (
                <SelectItem key={cadence} value={cadence}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {value.cadence === "hourly" ? (
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            Minute of hour
            <input
              type="number"
              min={0}
              max={59}
              value={value.minute}
              onChange={(event) =>
                update({ minute: clampNumber(event.target.value, 0, 59) })
              }
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        ) : value.cadence === "custom" ? (
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            Cron
            <input
              value={value.cron}
              onChange={(event) => update({ cron: event.target.value })}
              spellCheck={false}
              className="h-9 min-w-0 rounded-md border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="0 9 * * 1-5"
            />
          </label>
        ) : (
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            Time
            <input
              type="time"
              value={timeValue(value)}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(":").map(Number);
                update({ hour, minute });
              }}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        )}
      </div>

      {value.cadence === "weekly" && (
        <div className="flex flex-wrap gap-1.5">
          {DAY_NAMES.map((day, index) => (
            <button
              key={day}
              type="button"
              onClick={() => update({ dayOfWeek: index })}
              className={cn(
                "h-8 rounded-md border px-2.5 text-xs font-medium transition-colors",
                value.dayOfWeek === index
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background hover:bg-muted",
              )}
            >
              {day.slice(0, 3)}
            </button>
          ))}
        </div>
      )}

      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        Timezone
        <input
          value={value.timezone}
          onChange={(event) => update({ timezone: event.target.value })}
          className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
          helper.ok
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-destructive/25 bg-destructive/10 text-destructive",
        )}
      >
        {helper.ok ? (
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
        ) : (
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
        )}
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {helper.ok
            ? `${helper.text} (${helper.cron}). Runs in your local time: ${value.timezone}.`
            : helper.text}
        </span>
      </div>
    </div>
  );
}

function scheduleValueFromDraft(draft: AutomationDefinitionDraft) {
  return scheduleBuilderFromCron(draft.schedule, draft.timezone || localTimezone());
}

function applyScheduleToDraft(
  draft: AutomationDefinitionDraft,
  scheduleValue: ScheduleBuilderValue,
) {
  return {
    ...draft,
    schedule: cronFromBuilder(scheduleValue),
    timezone: scheduleValue.timezone,
  };
}

function runStatus(run: AutomationStatusRun | null | undefined): string {
  if (!run) return "no runs yet";
  if (run.status === "running") return "running now";
  if (run.status === "skipped") {
    return `skipped${run.skipReason ? `: ${run.skipReason}` : ""}`;
  }
  return `ran ${relativeTime(run.endedAt ?? run.updatedAt)}`;
}

function AutomationRow({
  automation,
  selected,
  lastRun,
  onSelect,
  onRunNow,
  onSetEnabled,
  onDelete,
}: {
  automation: AutomationRecord;
  selected: boolean;
  lastRun: AutomationRecord["lastRun"] | undefined;
  onSelect: () => void;
  onRunNow: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const status = automation.validationError
    ? automation.validationError
    : `${automation.enabled ? automation.scheduleDescription : "paused"} · ${runStatus(lastRun)}`;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
        selected
          ? "border-foreground/20 bg-muted"
          : "border-border bg-card hover:bg-muted/60",
        !automation.enabled && "opacity-55 hover:opacity-100",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <ClockIcon className="size-5 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold tracking-tight">
          {automation.name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {lastRun?.status === "running" && (
            <span className="size-1.5 shrink-0 rounded-full bg-[#F59E0B]" />
          )}
          <span className="truncate">
            {status}
          </span>
        </span>
      </span>
      <Menu>
        <MenuTrigger
          render={
            <span
              role="button"
              tabIndex={0}
              aria-label={`Actions for ${automation.name}`}
              onClick={(event) => event.stopPropagation()}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 data-[popup-open]:bg-muted data-[popup-open]:text-foreground data-[popup-open]:opacity-100"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            disabled={automation.validationError !== undefined}
            onClick={(event) => {
              event.stopPropagation();
              onRunNow();
            }}
          >
            <PlayIcon />
            Run now
          </MenuItem>
          <MenuItem
            onClick={(event) => {
              event.stopPropagation();
              onSetEnabled(!automation.enabled);
            }}
          >
            {automation.enabled ? <PauseCircleIcon /> : <PowerIcon />}
            {automation.enabled ? "Disable" : "Enable"}
          </MenuItem>
          <div className="my-1 h-px bg-border" />
          <MenuItem
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
          >
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </button>
  );
}

function RunRow({
  run,
  onResume,
}: {
  run: AutomationRunRecord;
  onResume: () => void;
}) {
  const resumable =
    run.chat !== null &&
    run.chat.deletedAt === undefined &&
    !run.chat.pending &&
    run.chat.resumeKind === "open-chat-command";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {run.status === "running" ? (
          <LoaderCircleIcon className="size-4 animate-spin" />
        ) : (
          <BotIcon className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{runStatus(run)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {run.trigger} · {relativeTime(run.startedAt ?? run.scheduledFor)}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!resumable}
        onClick={onResume}
      >
        Resume
        <CornerDownLeftIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function AutomationDetail({
  projectId,
  file,
  automation,
  runs,
  onSave,
  onRunNow,
}: {
  projectId: Id<"projects">;
  file: AutomationFileDoc;
  automation: AutomationRecord;
  runs: AutomationRunRecord[];
  onSave: (draft: AutomationDefinitionDraft) => Promise<void>;
  onRunNow: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFromContent(file.content));
  const [scheduleValue, setScheduleValue] = useState(() =>
    scheduleValueFromDraft(draftFromContent(file.content)),
  );
  const [saving, setSaving] = useState(false);
  const chatActions = useChatActions();

  useEffect(() => {
    const nextDraft = draftFromContent(file.content);
    setDraft(nextDraft);
    setScheduleValue(scheduleValueFromDraft(nextDraft));
  }, [file.content, file.path]);

  const scheduleStatus = scheduleHelper(scheduleValue);
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(draftFromContent(file.content)),
    [draft, file.content],
  );

  async function save() {
    if (!scheduleStatus.ok) return;
    setSaving(true);
    try {
      await onSave(applyScheduleToDraft(draft, scheduleValue));
    } finally {
      setSaving(false);
    }
  }

  function updateSchedule(nextValue: ScheduleBuilderValue) {
    setScheduleValue(nextValue);
    const status = scheduleHelper(nextValue);
    if (!status.ok) return;
    setDraft((next) => ({
      ...next,
      schedule: status.cron,
      timezone: nextValue.timezone,
    }));
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <input
            value={draft.name}
            onChange={(event) =>
              setDraft((next) => ({ ...next, name: event.target.value }))
            }
            className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none"
          />
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium uppercase text-muted-foreground">
            <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-1">
              <CalendarDaysIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                Schedule {automation.scheduleDescription || draft.schedule}
              </span>
            </span>
            <span className="rounded-md border border-border px-2 py-1">
              {draft.enabled ? "Enabled" : "Paused"}
            </span>
            <span className="rounded-md border border-border px-2 py-1">
              Last run {relativeTime(automation.lastRun?.endedAt ?? automation.lastRun?.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={automation.validationError !== undefined}
            onClick={onRunNow}
          >
            <PlayIcon />
            Run now
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving || !scheduleStatus.ok}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {automation.validationError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {automation.validationError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Schedule</h3>
            <p className="text-xs text-muted-foreground">
              Runs in your local time.
            </p>
          </div>
        </div>
        <ScheduleBuilder value={scheduleValue} onChange={updateSchedule} compact />
      </section>

      <label className="flex min-h-[220px] flex-1 flex-col gap-1.5 text-sm font-medium">
        Prompt
        <textarea
          value={draft.prompt}
          onChange={(event) =>
            setDraft((next) => ({ ...next, prompt: event.target.value }))
          }
          className="min-h-[220px] flex-1 resize-none rounded-lg border bg-background p-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Recent runs</h3>
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No runs yet.
          </div>
        ) : (
          runs.map((run) => (
            <RunRow
              key={run._id}
              run={run}
              onResume={() => {
                if (!run.chat) return;
                void chatActions.resumeChat({ projectId, id: run.chat._id });
              }}
            />
          ))
        )}
      </section>
    </section>
  );
}

function NewAutomationDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: AutomationDefinitionDraft) => Promise<string>;
}) {
  const [draft, setDraft] = useState(() => defaultAutomationDraft(""));
  const [scheduleValue, setScheduleValue] = useState(() =>
    scheduleValueFromDraft(defaultAutomationDraft("")),
  );
  const [creating, setCreating] = useState(false);
  const scheduleStatus = scheduleHelper(scheduleValue);

  useEffect(() => {
    if (!open) return;
    const nextDraft = defaultAutomationDraft("");
    setDraft(nextDraft);
    setScheduleValue(scheduleValueFromDraft(nextDraft));
  }, [open]);

  function updateSchedule(nextValue: ScheduleBuilderValue) {
    setScheduleValue(nextValue);
    const status = scheduleHelper(nextValue);
    if (!status.ok) return;
    setDraft((next) => ({
      ...next,
      schedule: status.cron,
      timezone: nextValue.timezone,
    }));
  }

  async function submit() {
    if (!scheduleStatus.ok || creating) return;
    setCreating(true);
    try {
      await onCreate(applyScheduleToDraft(draft, scheduleValue));
      onOpenChange(false);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>
            Schedule a fresh Codex run over a saved prompt.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((next) => ({ ...next, name: event.target.value }))
              }
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Review open PRs"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Prompt
            <div className="overflow-hidden rounded-xl border bg-background focus-within:ring-2 focus-within:ring-ring">
              <textarea
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((next) => ({ ...next, prompt: event.target.value }))
                }
                spellCheck={false}
                rows={6}
                className="block min-h-32 w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
                placeholder="Describe exactly what the agent should do each time this automation runs."
              />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2.5 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs font-medium">
                    <HarnessIcon harness="codex" className="size-4" />
                    Codex
                  </span>
                  <span className="inline-flex h-7 items-center rounded-md bg-muted px-2 text-xs text-muted-foreground">
                    {draft.model ?? "gpt-5.5"}
                  </span>
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-muted-foreground">
                    <GaugeIcon className="size-3.5" />
                    {draft.effort ?? "medium"}
                  </span>
                </div>
              </div>
            </div>
          </label>

          <section className="rounded-xl border border-border bg-card p-3">
            <div className="mb-3">
              <h3 className="text-sm font-semibold">Schedule</h3>
              <p className="text-xs text-muted-foreground">
                Presets compile to cron and run in your local time.
              </p>
            </div>
            <ScheduleBuilder value={scheduleValue} onChange={updateSchedule} />
          </section>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="min-w-0 text-left text-xs text-muted-foreground">
            {scheduleStatus.ok ? (
              <span className="block truncate">
                {scheduleStatus.text} · {scheduleStatus.cron}
              </span>
            ) : (
              <span className="text-destructive">{scheduleStatus.text}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!scheduleStatus.ok || creating}
              onClick={() => void submit()}
            >
              {creating ? "Creating..." : "Create automation"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AutomationsView({
  projectId,
  files,
  intent,
  onIntentHandled,
  onExit,
}: {
  projectId: Id<"projects">;
  files: AutomationFileDoc[];
  intent: string | null;
  onIntentHandled: () => void;
  onExit: () => void;
}) {
  const { loading, automations } = useAutomationDefinitions(projectId, {
    includeInvalid: true,
  });
  const actions = useAutomationActions(projectId, files);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const selected = selectedPath
    ? automations.find((automation) => automation.automationPath === selectedPath)
    : null;
  const effectiveSelected = selected ?? automations[0] ?? null;
  const selectedFile = effectiveSelected
    ? automationFileForPath(files, effectiveSelected.automationPath)
    : null;
  const { runs } = useAutomationRuns(
    projectId,
    effectiveSelected?.automationPath,
    10,
  );
  useEffect(() => {
    if (selectedPath && automations.some((a) => a.automationPath === selectedPath)) {
      return;
    }
    setSelectedPath(automations[0]?.automationPath ?? null);
  }, [automations, selectedPath]);

  useEffect(() => {
    if (!intent) return;
    setSelectedPath(intent);
    onIntentHandled();
  }, [intent, onIntentHandled]);

  async function createAutomation(draft: AutomationDefinitionDraft) {
    const path = await actions.createAutomation(draft.name, draft);
    setSelectedPath(path);
    return path;
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
        Loading automations...
      </div>
    );
  }

  if (automations.length === 0) {
    return (
      <>
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
            <ClockIcon className="size-6 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">No automations yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Schedule a fresh agent run over a saved prompt.
            </p>
          </div>
          <Button type="button" onClick={() => setNewOpen(true)}>
            <PlusIcon />
            New automation
          </Button>
        </div>
        <NewAutomationDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          onCreate={createAutomation}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 gap-5">
        <aside className="flex w-[360px] shrink-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onExit}>
              <ChevronLeftIcon />
              Board
            </Button>
            <Button type="button" size="sm" onClick={() => setNewOpen(true)}>
              <PlusIcon />
              New automation
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {automations.map((automation) => (
              <AutomationRow
                key={automation._id}
                automation={automation}
                selected={automation.automationPath === effectiveSelected?.automationPath}
                lastRun={automation.lastRun ?? undefined}
                onSelect={() => setSelectedPath(automation.automationPath)}
                onRunNow={() => void actions.runNow(automation.automationPath)}
                onSetEnabled={(enabled) =>
                  void actions.setEnabled(automation.automationPath, enabled)
                }
                onDelete={() => void actions.deleteAutomation(automation.automationPath)}
              />
            ))}
          </div>
        </aside>

        {effectiveSelected && selectedFile ? (
          <AutomationDetail
            projectId={projectId}
            file={selectedFile}
            automation={effectiveSelected}
            runs={runs}
            onSave={(draft) =>
              actions.updateAutomation(effectiveSelected.automationPath, draft)
            }
            onRunNow={() => void actions.runNow(effectiveSelected.automationPath)}
          />
        ) : (
          <div className="flex min-h-[40vh] flex-1 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Automation source file is syncing.
          </div>
        )}
      </div>
      <NewAutomationDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={createAutomation}
      />
    </>
  );
}
