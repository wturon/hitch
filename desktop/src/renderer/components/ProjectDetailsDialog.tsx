"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertCircleIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  FolderOpenIcon,
  GripVerticalIcon,
  HashIcon,
  InfoIcon,
  ListChecksIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type ProjectStatus,
} from "@/lib/projectConfig";
import {
  statusCardCountLabel,
  statusFrontmatterLine,
  statusesForProject,
  uniqueStatusId,
} from "@/lib/statuses";
import { cn } from "@/lib/utils";

const projectDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

type ProjectDetails = NonNullable<
  FunctionReturnType<typeof api.projects.details>
>;

export type DetailsTab = "general" | "statuses" | "local" | "members";

const TABS = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "statuses", label: "Statuses", icon: ListChecksIcon },
  { id: "local", label: "Local setup", icon: FolderOpenIcon },
  { id: "members", label: "Members", icon: UsersIcon },
] as const satisfies ReadonlyArray<{
  id: DetailsTab;
  label: string;
  icon: typeof Settings2Icon;
}>;

interface HitchBinding {
  projectId: Id<"projects">;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

interface LocalHitchConfig {
  hitches: HitchBinding[];
}

interface RemoveHitchResult {
  config: LocalHitchConfig;
  removed: boolean;
  restarted: boolean;
}

interface ProjectSetupStatus {
  projectId: Id<"projects">;
  hitch: HitchBinding | null;
  localPathExists: boolean;
  hitchPath: string | null;
  hitchPathExists: boolean;
  gitignorePath: string | null;
  gitignoreExists: boolean;
  gitignoreHasHitch: boolean;
}

interface HitchDaemonApi {
  addHitch: (input: {
    projectId: Id<"projects">;
    projectName?: string;
    localPath: string;
    updateGitignore?: boolean;
  }) => Promise<{
    config: LocalHitchConfig;
    gitignoreUpdated: boolean;
    restarted: boolean;
  }>;
  removeHitch: (projectId: Id<"projects">) => Promise<RemoveHitchResult>;
  getProjectSetup: (projectId: Id<"projects">) => Promise<ProjectSetupStatus>;
  ensureHitchDirectory: (
    projectId: Id<"projects">,
  ) => Promise<ProjectSetupStatus>;
  ensureGitignore: (projectId: Id<"projects">) => Promise<ProjectSetupStatus>;
  chooseLocalPath: (defaultPath?: string) => Promise<string | null>;
}

function formatDate(timestamp: number) {
  return projectDateFormatter.format(new Date(timestamp));
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function statusFingerprint(statuses: ProjectStatus[]) {
  return JSON.stringify(statuses.map((status) => [status.id, status.name]));
}

function nextDraftStatus(statuses: ProjectStatus[]): ProjectStatus {
  return { id: uniqueStatusId("New status", statuses), name: "New status" };
}

function reorderStatuses(
  statuses: ProjectStatus[],
  activeId: string,
  overId: string,
) {
  const activeIndex = statuses.findIndex((status) => status.id === activeId);
  const overIndex = statuses.findIndex((status) => status.id === overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return statuses;
  }

  return arrayMove(statuses, activeIndex, overIndex);
}

function StatusRow({
  status,
  canEdit,
  disabled,
  canRemove,
  isActive,
  cardCount,
  autoFocus,
  copied,
  onNameCommit,
  onCopy,
  onRemove,
}: {
  status: ProjectStatus;
  canEdit: boolean;
  disabled: boolean;
  canRemove: boolean;
  isActive: boolean;
  cardCount: number | null;
  autoFocus?: boolean;
  copied: boolean;
  onNameCommit: (id: string, name: string) => void;
  onCopy: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState(status.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: status.id,
    disabled: disabled || !canEdit || autoFocus === true,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    setName(status.name);
  }, [status.id, status.name]);

  useEffect(() => {
    if (!autoFocus) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [autoFocus]);

  function commitName() {
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      setName(status.name);
      return;
    }
    onNameCommit(status.id, trimmed);
  }

  function onNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      setName(status.name);
      event.currentTarget.blur();
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex min-h-12 items-center gap-2 rounded-md border bg-background px-2.5 py-2 transition-shadow",
        isOver && !isActive && "ring-2 ring-ring",
        isDragging && "opacity-40",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled || !canEdit}
        aria-label={`Drag ${status.name}`}
        className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <input
        ref={inputRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={onNameKeyDown}
        disabled={!canEdit || disabled}
        aria-label={`Status name: ${status.name}`}
        className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium outline-none transition-shadow hover:border-border hover:bg-background focus-visible:border-border focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
        {statusCardCountLabel(cardCount)}
      </span>
      <button
        type="button"
        disabled={disabled || autoFocus === true}
        onClick={() => onCopy(status.id)}
        aria-label={`Copy status id ${status.id}`}
        className="flex h-7 w-36 shrink-0 items-center justify-between gap-1 rounded-sm bg-secondary py-1 pl-2 pr-1 font-mono text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 truncate">{status.id}</span>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[4px]">
          {copied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!canEdit || disabled || !canRemove}
        onClick={() => onRemove(status.id)}
        aria-label="Remove status"
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

export function ProjectDetailsDialog({
  projectId,
  open,
  onOpenChange,
  onLocalConfigChange,
  initialTab = "general",
}: {
  projectId: Id<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
  initialTab?: DetailsTab;
}) {
  const details = useQuery(api.projects.details, open ? { projectId } : "skip");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(820px,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Project details</DialogTitle>
          <DialogDescription>
            {details?.project?.name ?? "Project settings"}
          </DialogDescription>
        </DialogHeader>

        {details === undefined ? (
          <div className="py-8 text-sm text-muted-foreground">
            Loading project…
          </div>
        ) : details === null ? (
          <div className="py-8 text-sm text-muted-foreground">
            Project details are not available.
          </div>
        ) : (
          <ProjectDetailsForm
            key={`${details.project._id}:${details.project.name}`}
            projectId={projectId}
            details={details}
            onLocalConfigChange={onLocalConfigChange}
            initialTab={initialTab}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProjectDetailsForm({
  projectId,
  details,
  onLocalConfigChange,
  initialTab,
}: {
  projectId: Id<"projects">;
  details: ProjectDetails;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
  initialTab: DetailsTab;
}) {
  const bridge =
    typeof window !== "undefined"
      ? (window as unknown as { hitchDaemon?: HitchDaemonApi }).hitchDaemon
      : undefined;
  const updateDetails = useMutation(api.projects.updateDetails);
  const updateStatuses = useMutation(api.projects.updateStatuses);
  const renameStatusWithMigration = useMutation(
    api.projects.renameStatusWithMigration,
  );
  const deleteStatusWithMigration = useMutation(
    api.projects.deleteStatusWithMigration,
  );
  const ensureProjectConfig = useMutation(api.projects.ensureProjectConfig);
  const statusCardCounts = useQuery(api.projects.statusCardCounts, {
    projectId,
  });
  const projectConfigFile = useQuery(api.files.getFile, {
    projectId,
    path: PROJECT_CONFIG_PATH,
  });
  const projectConfig = useMemo(
    () => parseProjectConfig(projectConfigFile?.content, projectId),
    [projectConfigFile?.content, projectId],
  );
  const configuredStatuses = useMemo(
    () =>
      projectConfig?.tasks?.statuses?.length
        ? projectConfig.tasks.statuses
        : details.project.statuses,
    [details.project.statuses, projectConfig?.tasks?.statuses],
  );
  const [tab, setTab] = useState<DetailsTab>(initialTab);
  const [name, setName] = useState(details.project.name);
  const [statuses, setStatuses] = useState<ProjectStatus[]>(
    statusesForProject(configuredStatuses),
  );
  const [draftStatusId, setDraftStatusId] = useState<string | null>(null);
  const [setup, setSetup] = useState<ProjectSetupStatus | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [activeStatusId, setActiveStatusId] = useState<string | null>(null);
  const [copiedStatusId, setCopiedStatusId] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const canEdit = details.membership?.role === "owner";
  const trimmedName = name.trim();
  const hasNameChange = trimmedName !== details.project.name;
  const savedStatuses = statusesForProject(configuredStatuses);
  const statusCountsById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of statusCardCounts ?? []) {
      if (item.configured) counts.set(item.statusId, item.count);
    }
    return counts;
  }, [statusCardCounts]);
  const statusSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const activeStatus = activeStatusId
    ? (statuses.find((status) => status.id === activeStatusId) ?? null)
    : null;
  const statusIds = useMemo(
    () => statuses.map((status) => status.id),
    [statuses],
  );

  useEffect(() => {
    setStatuses(statusesForProject(configuredStatuses));
    setDraftStatusId(null);
  }, [configuredStatuses, details.project._id]);

  useEffect(() => {
    if (!copiedStatusId) return;
    const timeout = window.setTimeout(() => setCopiedStatusId(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [copiedStatusId]);

  useEffect(() => {
    if (projectConfigFile === undefined) return;
    if (projectConfigFile && !projectConfigFile.deleted && projectConfig) return;
    void ensureProjectConfig({ projectId }).catch(() => {
      // Existing projects can keep using project-row statuses until backfill works.
    });
  }, [ensureProjectConfig, projectConfig, projectConfigFile, projectId]);

  useEffect(() => {
    setTab(initialTab);
  }, [details.project._id, initialTab]);

  async function refreshSetup() {
    if (!bridge) return;
    const next = await bridge.getProjectSetup(projectId);
    setSetup(next);
    setLocalPath(next.hitch?.localPath ?? "");
  }

  useEffect(() => {
    void refreshSetup().catch((err) => {
      setSetupError(err instanceof Error ? err.message : String(err));
    });
  }, [bridge, projectId]);

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !trimmedName || !hasNameChange) return;

    setSaving(true);
    setError(null);
    try {
      await updateDetails({ projectId, name: trimmedName });
      setName(trimmedName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function persistStatuses(
    nextStatuses: ProjectStatus[],
    previousStatuses: ProjectStatus[] = statuses,
  ) {
    if (!canEdit) return;
    if (statusFingerprint(nextStatuses) === statusFingerprint(previousStatuses)) {
      return;
    }

    setStatusBusy(true);
    setStatusError(null);
    try {
      const next = await updateStatuses({ projectId, statuses: nextStatuses });
      setStatuses(statusesForProject(next?.statuses));
      setDraftStatusId(null);
    } catch (err) {
      setStatuses(previousStatuses);
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  }

  function addStatus() {
    if (!canEdit || statusBusy || draftStatusId) return;
    setStatusError(null);
    setStatuses((current) => {
      const draft = nextDraftStatus(current);
      setDraftStatusId(draft.id);
      return [...current, draft];
    });
  }

  async function commitStatusName(id: string, nextName: string) {
    const trimmed = nextName.trim().replace(/\s+/g, " ");
    if (!canEdit || statusBusy || !trimmed) return;

    const previousStatuses = statuses;
    const currentStatus = previousStatuses.find((status) => status.id === id);
    if (!currentStatus) return;
    if (currentStatus.name === trimmed && draftStatusId !== id) return;

    const cardCount = statusCountsById.get(id) ?? 0;
    setStatusError(null);
    setStatusBusy(true);
    try {
      if (draftStatusId === id || cardCount === 0) {
        const nextStatuses = previousStatuses.map((status) =>
          status.id === id ? { ...status, name: trimmed } : status,
        );
        const next = await updateStatuses({ projectId, statuses: nextStatuses });
        setStatuses(statusesForProject(next?.statuses));
      } else {
        const confirmed = window.confirm(
          `Rename "${currentStatus.name}" to "${trimmed}" and update ${statusCardCountLabel(cardCount)}?`,
        );
        if (!confirmed) return;
        const next = await renameStatusWithMigration({
          projectId,
          statusId: id,
          name: trimmed,
        });
        setStatuses(statusesForProject(next?.statuses));
      }
      setDraftStatusId(null);
    } catch (err) {
      setStatuses(previousStatuses);
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  }

  async function copyStatusId(id: string) {
    const text = statusFrontmatterLine(id);
    setStatusError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStatusId(id);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeStatus(id: string) {
    if (!canEdit || statusBusy || statuses.length <= 1) return;

    const previousStatuses = statuses;
    const currentStatus = previousStatuses.find((status) => status.id === id);
    if (!currentStatus) return;

    if (draftStatusId === id) {
      setStatuses(previousStatuses.filter((status) => status.id !== id));
      setDraftStatusId(null);
      setStatusError(null);
      return;
    }

    const cardCount = statusCountsById.get(id) ?? 0;
    const confirmed = window.confirm(
      cardCount > 0
        ? `Delete "${currentStatus.name}" and choose where to move ${statusCardCountLabel(cardCount)}?`
        : `Delete "${currentStatus.name}"?`,
    );
    if (!confirmed) return;

    setStatusBusy(true);
    setStatusError(null);
    try {
      if (cardCount > 0) {
        setStatusError(
          "Delete migration is ready, but the destination picker ships in the next Statuses task.",
        );
        return;
      }
      const next = await deleteStatusWithMigration({ projectId, statusId: id });
      setStatuses(statusesForProject(next?.statuses));
      if (draftStatusId === id) setDraftStatusId(null);
    } catch (err) {
      setStatuses(previousStatuses);
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  }

  function onStatusDragStart(event: DragStartEvent) {
    setActiveStatusId(String(event.active.id));
  }

  function onStatusDragEnd(event: DragEndEvent) {
    setActiveStatusId(null);
    const { active, over } = event;
    if (!over || draftStatusId !== null) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const nextStatuses = reorderStatuses(statuses, activeId, overId);
    setStatuses(nextStatuses);
    void persistStatuses(nextStatuses, statuses);
  }

  async function chooseFolder() {
    if (!bridge) return;
    setSetupError(null);
    const chosen = await bridge.chooseLocalPath(localPath || undefined);
    if (chosen) setLocalPath(chosen);
  }

  async function hitchProject() {
    if (!bridge || !localPath.trim()) return;
    setSetupBusy("hitch");
    setSetupError(null);
    try {
      await ensureProjectConfig({ projectId });
      const result = await bridge.addHitch({
        projectId,
        projectName: details.project.name,
        localPath,
        updateGitignore: true,
      });
      onLocalConfigChange?.(result.config);
      await refreshSetup();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupBusy(null);
    }
  }

  async function unhitchProject() {
    if (!bridge || !setup?.hitch) return;
    const label = details.project.name || projectId;
    const confirmed = window.confirm(
      `Unhitch ${label} from this machine? Local .hitch files and .gitignore will be left unchanged.`,
    );
    if (!confirmed) return;

    setSetupBusy("unhitch");
    setSetupError(null);
    try {
      const result = await bridge.removeHitch(projectId);
      onLocalConfigChange?.(result.config);
      await refreshSetup();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupBusy(null);
    }
  }

  async function repairSetup(action: "hitch" | "gitignore") {
    if (!bridge) return;
    setSetupBusy(action);
    setSetupError(null);
    try {
      const next =
        action === "hitch"
          ? await bridge.ensureHitchDirectory(projectId)
          : await bridge.ensureGitignore(projectId);
      setSetup(next);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      <nav className="flex w-36 shrink-0 flex-col gap-1 overflow-y-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
              tab === id
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      <form
        className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
        onSubmit={saveProject}
      >
        <div className="flex flex-col gap-4">
          {tab === "general" && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Title
                </span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={!canEdit || saving}
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <HashIcon className="size-3.5" />
                    Project ID
                  </div>
                  <p className="mt-1 truncate text-sm font-medium">
                    {details.project._id}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <ShieldCheckIcon className="size-3.5" />
                    Your role
                  </div>
                  <p className="mt-1 capitalize text-sm font-medium">
                    {details.membership?.role ?? "member"}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <CalendarIcon className="size-3.5" />
                    Created
                  </div>
                  <p className="mt-1 text-sm font-medium">
                    {formatDate(details.project.createdAt)}
                  </p>
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    !canEdit || saving || !trimmedName || !hasNameChange
                  }
                >
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </DialogFooter>
            </>
          )}

          {tab === "statuses" && (
            <section className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold leading-6">Statuses</h3>
                  <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
                    Your board columns, in order. Drag to reorder. Each status
                    has an id that agents read from task files, and it updates
                    automatically when you rename.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canEdit || statusBusy || draftStatusId !== null}
                  onClick={addStatus}
                >
                  <PlusIcon />
                  Add status
                </Button>
              </div>

              <DndContext
                sensors={statusSensors}
                collisionDetection={closestCenter}
                onDragStart={onStatusDragStart}
                onDragEnd={onStatusDragEnd}
                onDragCancel={() => setActiveStatusId(null)}
              >
                <SortableContext
                  items={statusIds}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-2">
                    {statuses.map((status) => (
                      <StatusRow
                        key={status.id}
                        status={status}
                        canEdit={canEdit}
                        disabled={
                          statusBusy ||
                          (draftStatusId !== null && draftStatusId !== status.id)
                        }
                        canRemove={statuses.length > 1}
                        isActive={activeStatusId === status.id}
                        cardCount={
                          statusCountsById.has(status.id)
                            ? (statusCountsById.get(status.id) ?? 0)
                            : null
                        }
                        autoFocus={draftStatusId === status.id}
                        copied={copiedStatusId === status.id}
                        onNameCommit={(id, nextName) =>
                          void commitStatusName(id, nextName)
                        }
                        onCopy={(id) => void copyStatusId(id)}
                        onRemove={removeStatus}
                      />
                    ))}
                  </div>
                </SortableContext>
                {typeof document !== "undefined"
                  ? createPortal(
                      <DragOverlay dropAnimation={null}>
                        {activeStatus ? (
                          <div className="flex min-h-12 w-[320px] items-center gap-2 rounded-md border bg-background px-2.5 py-2 shadow-lg ring-foreground/20">
                            <GripVerticalIcon className="size-4 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {activeStatus.name}
                            </span>
                            <span className="rounded-sm bg-secondary px-2 py-1 font-mono text-xs text-muted-foreground">
                              {activeStatus.id}
                            </span>
                          </div>
                        ) : null}
                      </DragOverlay>,
                      document.body,
                    )
                  : null}
              </DndContext>

              <div className="flex items-start gap-2 pt-1 text-xs leading-5 text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                <p className="max-w-2xl">
                  Reordering applies right away. Renaming or removing a status
                  that has cards will ask where those cards should go before
                  anything changes.{" "}
                  <span className="font-mono text-[0.72rem]">archived</span> is
                  a reserved system status and is not shown here.
                </p>
              </div>

              {copiedStatusId && (
                <p className="text-sm text-muted-foreground">
                  Copied{" "}
                  <span className="font-mono">status: {copiedStatusId}</span>
                </p>
              )}
              {statusError && (
                <p className="text-sm text-destructive">{statusError}</p>
              )}
            </section>
          )}

          {tab === "local" && (
            <section className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">Local setup</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Bind this project to the folder where you work on its repo.
                    Hitch keeps that folder&apos;s .hitch workspace private.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!bridge || setupBusy !== null}
                  onClick={() => void refreshSetup()}
                  aria-label="Refresh local setup"
                >
                  <RefreshCwIcon />
                </Button>
              </div>

              {!bridge ? (
                <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
                  Local setup checks are only available inside Hitch Desktop.
                </p>
              ) : setup === null ? (
                <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
                  Checking local setup...
                </p>
              ) : setup.hitch ? (
                <div className="flex flex-col gap-2">
                  <SetupCheck
                    ok={setup.localPathExists}
                    title="Project folder"
                    detail={setup.hitch.localPath}
                  />
                  <SetupCheck
                    ok={setup.hitchPathExists}
                    title=".hitch folder"
                    detail={setup.hitchPath ?? ""}
                    action={
                      setup.localPathExists && !setup.hitchPathExists ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={setupBusy !== null}
                          onClick={() => void repairSetup("hitch")}
                        >
                          {setupBusy === "hitch" ? "Creating..." : "Create"}
                        </Button>
                      ) : null
                    }
                  />
                  <SetupCheck
                    ok={setup.gitignoreHasHitch}
                    title=".gitignore"
                    detail={
                      setup.gitignoreHasHitch
                        ? ".hitch/ is ignored"
                        : setup.gitignoreExists
                          ? ".hitch/ is not ignored yet"
                          : ".gitignore will be created"
                    }
                    action={
                      setup.localPathExists && !setup.gitignoreHasHitch ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={setupBusy !== null}
                          onClick={() => void repairSetup("gitignore")}
                        >
                          {setupBusy === "gitignore" ? "Adding..." : "Add"}
                        </Button>
                      ) : null
                    }
                  />
                  <div className="mt-1 rounded-md border bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="text-sm font-medium">Unhitch locally</h4>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Stop syncing this project on this machine. The local
                          .hitch folder and .gitignore stay unchanged.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={setupBusy !== null}
                        onClick={() => void unhitchProject()}
                      >
                        <Trash2Icon />
                        {setupBusy === "unhitch" ? "Unhitching..." : "Unhitch"}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
                    Choose the local checkout for this project, usually the same
                    directory where you cloned the repository.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={localPath}
                      onChange={(event) => setLocalPath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void hitchProject();
                        }
                      }}
                      placeholder="/Users/you/code/project"
                      spellCheck={false}
                      className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      disabled={setupBusy !== null}
                      onClick={() => void chooseFolder()}
                      aria-label="Choose local folder"
                    >
                      <FolderOpenIcon />
                    </Button>
                  </div>
                  <Button
                    type="button"
                    disabled={!localPath.trim() || setupBusy !== null}
                    onClick={() => void hitchProject()}
                  >
                    {setupBusy === "hitch" ? "Hitching..." : "Hitch project"}
                  </Button>
                </div>
              )}

              {setupError && (
                <p className="text-sm text-destructive">{setupError}</p>
              )}
            </section>
          )}

          {tab === "members" && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <UsersIcon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">
                  Members ({details.members.length})
                </h3>
              </div>
              <div className="overflow-hidden rounded-lg border">
                {details.members.map((member) => {
                  const displayName =
                    member.user?.name ?? member.user?.email ?? "Unknown member";
                  const email =
                    member.user?.email && member.user.email !== displayName
                      ? member.user.email
                      : null;
                  return (
                    <div
                      key={member.membershipId}
                      className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                    >
                      {member.user?.image ? (
                        <img
                          src={member.user.image}
                          alt=""
                          className="size-8 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                          {initials(displayName) || "?"}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {displayName}
                        </p>
                        {email && (
                          <p className="truncate text-xs text-muted-foreground">
                            {email}
                          </p>
                        )}
                      </div>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                        {member.role}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </form>
    </div>
  );
}

function SetupCheck({
  ok,
  title,
  detail,
  action,
}: {
  ok: boolean;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-md border bg-background px-3 py-2">
      {ok ? (
        <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
      ) : (
        <AlertCircleIcon className="size-4 shrink-0 text-amber-500" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </p>
      </div>
      {action}
    </div>
  );
}
