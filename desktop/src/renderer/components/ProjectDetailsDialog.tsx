"use client";

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlertCircleIcon,
  CalendarIcon,
  CheckCircle2Icon,
  FolderOpenIcon,
  GripVerticalIcon,
  HashIcon,
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

const DEFAULT_STATUSES = [
  { id: "todo", name: "To Do" },
  { id: "in-progress", name: "In Progress" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
] as const satisfies ProjectStatus[];

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

function statusesForProject(
  statuses: ProjectStatus[] | undefined,
): ProjectStatus[] {
  return statuses?.length ? statuses : [...DEFAULT_STATUSES];
}

function statusIdFromName(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueStatusId(name: string, existing: ProjectStatus[]) {
  const root = statusIdFromName(name) || "status";
  const taken = new Set(existing.map((status) => status.id));
  let id = root === "archived" ? "status" : root;
  let suffix = 2;
  while (taken.has(id) || id === "archived") {
    id = `${root}-${suffix}`;
    suffix += 1;
  }
  return id;
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

  const next = [...statuses];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
}

function StatusRow({
  status,
  index,
  canEdit,
  disabled,
  canRemove,
  isActive,
  onNameChange,
  onRemove,
}: {
  status: ProjectStatus;
  index: number;
  canEdit: boolean;
  disabled: boolean;
  canRemove: boolean;
  isActive: boolean;
  onNameChange: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    isDragging,
  } = useDraggable({
    id: status.id,
    disabled: disabled || !canEdit,
  });
  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: status.id,
  });

  function setNodeRef(node: HTMLDivElement | null) {
    setDraggableNodeRef(node);
    setDroppableNodeRef(node);
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-10 items-center gap-2 rounded-md border bg-background px-2 py-1.5 transition-shadow",
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
      <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
        {index + 1}
      </span>
      <input
        value={status.name}
        onChange={(event) => onNameChange(status.id, event.target.value)}
        disabled={!canEdit || disabled}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      />
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
      <DialogContent className="flex h-[600px] max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-3xl">
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
  const ensureProjectConfig = useMutation(api.projects.ensureProjectConfig);
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
  const [setup, setSetup] = useState<ProjectSetupStatus | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingStatuses, setSavingStatuses] = useState(false);
  const [activeStatusId, setActiveStatusId] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const canEdit = details.membership?.role === "owner";
  const trimmedName = name.trim();
  const hasNameChange = trimmedName !== details.project.name;
  const savedStatuses = statusesForProject(configuredStatuses);
  const hasStatusChange =
    statusFingerprint(statuses) !== statusFingerprint(savedStatuses);
  const hasInvalidStatus = statuses.some((status) => !status.name.trim());
  const statusSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const activeStatus = activeStatusId
    ? (statuses.find((status) => status.id === activeStatusId) ?? null)
    : null;

  useEffect(() => {
    setStatuses(statusesForProject(configuredStatuses));
  }, [configuredStatuses, details.project._id]);

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

  async function saveStatuses() {
    if (!canEdit || !hasStatusChange || hasInvalidStatus) return;

    setSavingStatuses(true);
    setStatusError(null);
    try {
      const next = await updateStatuses({ projectId, statuses });
      setStatuses(statusesForProject(next?.statuses));
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingStatuses(false);
    }
  }

  function updateStatusName(id: string, nextName: string) {
    setStatuses((current) =>
      current.map((status) =>
        status.id === id ? { ...status, name: nextName } : status,
      ),
    );
  }

  function addStatus() {
    setStatuses((current) => [
      ...current,
      { id: uniqueStatusId("New status", current), name: "New status" },
    ]);
  }

  function removeStatus(id: string) {
    setStatuses((current) =>
      current.length <= 1
        ? current
        : current.filter((status) => status.id !== id),
    );
  }

  function onStatusDragStart(event: DragStartEvent) {
    setActiveStatusId(String(event.active.id));
  }

  function onStatusDragEnd(event: DragEndEvent) {
    setActiveStatusId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    setStatuses((current) => reorderStatuses(current, activeId, overId));
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
            <section className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">Statuses</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Configure this project's Kanban columns.
                  </p>
                </div>
                <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
              </div>

              <DndContext
                sensors={statusSensors}
                onDragStart={onStatusDragStart}
                onDragEnd={onStatusDragEnd}
                onDragCancel={() => setActiveStatusId(null)}
              >
                <div className="flex flex-col gap-2">
                  {statuses.map((status, index) => (
                    <StatusRow
                      key={status.id}
                      status={status}
                      index={index}
                      canEdit={canEdit}
                      disabled={savingStatuses}
                      canRemove={statuses.length > 1}
                      isActive={activeStatusId === status.id}
                      onNameChange={updateStatusName}
                      onRemove={removeStatus}
                    />
                  ))}
                </div>
                <DragOverlay dropAnimation={null}>
                  {activeStatus ? (
                    <div className="flex min-h-10 items-center gap-2 rounded-md border bg-background px-2 py-1.5 shadow-lg ring-foreground/20">
                      <GripVerticalIcon className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {activeStatus.name}
                      </span>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canEdit || savingStatuses}
                  onClick={addStatus}
                >
                  <PlusIcon />
                  Add status
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !canEdit ||
                    savingStatuses ||
                    !hasStatusChange ||
                    hasInvalidStatus
                  }
                  onClick={() => void saveStatuses()}
                >
                  {savingStatuses ? "Saving..." : "Save statuses"}
                </Button>
              </div>

              {hasInvalidStatus && (
                <p className="text-sm text-destructive">
                  Status names cannot be blank.
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
