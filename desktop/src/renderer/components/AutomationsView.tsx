"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BotIcon,
  ChevronLeftIcon,
  ClockIcon,
  CornerDownLeftIcon,
  EllipsisIcon,
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
  draftFromContent,
  type AutomationDefinitionDraft,
  type AutomationFileDoc,
  type AutomationRecord,
  type AutomationRunRecord,
} from "@/lib/automations";
import { useChatActions } from "@/hooks/useChats";
import {
  useAutomationActions,
  useAutomationDefinitions,
  useAutomationRuns,
} from "@/hooks/useAutomations";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
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
            {automation.enabled ? automation.scheduleDescription : "paused"} ·{" "}
            {runStatus(lastRun)}
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
  const [saving, setSaving] = useState(false);
  const chatActions = useChatActions();

  useEffect(() => {
    setDraft(draftFromContent(file.content));
  }, [file.content, file.path]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(draftFromContent(file.content)),
    [draft, file.content],
  );

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
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
            <span className="rounded-md border border-border px-2 py-1">
              Schedule {automation.scheduleDescription || draft.schedule}
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
          <Button type="button" variant="outline" size="sm" onClick={onRunNow}>
            <PlayIcon />
            Run now
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Schedule
          <input
            value={draft.schedule}
            onChange={(event) =>
              setDraft((next) => ({ ...next, schedule: event.target.value }))
            }
            className="h-9 rounded-md border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Timezone
          <input
            value={draft.timezone}
            onChange={(event) =>
              setDraft((next) => ({ ...next, timezone: event.target.value }))
            }
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>

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

  async function createAutomation() {
    const path = await actions.createAutomation("Untitled automation");
    setSelectedPath(path);
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
        <Button type="button" onClick={() => void createAutomation()}>
          <PlusIcon />
          New automation
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-5">
      <aside className="flex w-[360px] shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onExit}>
            <ChevronLeftIcon />
            Board
          </Button>
          <Button type="button" size="sm" onClick={() => void createAutomation()}>
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
  );
}
