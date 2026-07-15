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
  AlertCircleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarIcon,
  CheckCircle2Icon,
  FolderOpenIcon,
  HashIcon,
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
import { parseProjectConfig, PROJECT_CONFIG_PATH } from "@/lib/projectConfig";
import { cn } from "@/lib/utils";

const projectDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

type ProjectDetails = NonNullable<
  FunctionReturnType<typeof api.projects.details>
>;

export type DetailsTab = "general" | "local" | "members" | "archive";

const TABS = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "local", label: "Local setup", icon: FolderOpenIcon },
  { id: "members", label: "Members", icon: UsersIcon },
  { id: "archive", label: "Archive", icon: ArchiveIcon },
] as const satisfies ReadonlyArray<{
  id: DetailsTab;
  label: string;
  icon: typeof Settings2Icon;
}>;

// A row in the Archive tab, already bound to its unarchive/delete actions —
// the dialog stays dumb about how todos persist; the workspace (which owns
// the files subscription and undo toasts) supplies them.
export interface ArchivedItem {
  key: string;
  title: string;
  detail: string;
  onUnarchive: () => void;
  onDelete: () => void;
}

export interface ProjectArchive {
  todos: ArchivedItem[];
  onDeleteAllTodos: () => void;
}

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

export function ProjectDetailsDialog({
  projectId,
  open,
  onOpenChange,
  onLocalConfigChange,
  initialTab = "general",
  archive,
}: {
  projectId: Id<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
  initialTab?: DetailsTab;
  archive?: ProjectArchive;
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
            archive={archive}
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
  archive,
}: {
  projectId: Id<"projects">;
  details: ProjectDetails;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
  initialTab: DetailsTab;
  archive?: ProjectArchive;
}) {
  const bridge =
    typeof window !== "undefined"
      ? (window as unknown as { hitchDaemon?: HitchDaemonApi }).hitchDaemon
      : undefined;
  const updateDetails = useMutation(api.projects.updateDetails);
  const ensureProjectConfig = useMutation(api.projects.ensureProjectConfig);
  const projectConfigFile = useQuery(api.files.getFile, {
    projectId,
    path: PROJECT_CONFIG_PATH,
  });
  const projectConfig = useMemo(
    () => parseProjectConfig(projectConfigFile?.content, projectId),
    [projectConfigFile?.content, projectId],
  );
  const [tab, setTab] = useState<DetailsTab>(initialTab);
  const [name, setName] = useState(details.project.name);
  const [setup, setSetup] = useState<ProjectSetupStatus | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const canEdit = details.membership?.role === "owner";
  const trimmedName = name.trim();
  const hasNameChange = trimmedName !== details.project.name;

  // Backfill project.json if it's missing or malformed. Orthogonal to the board
  // teardown — project.json is now just {version, projectId, name}.
  useEffect(() => {
    if (projectConfigFile === undefined) return;
    if (projectConfigFile && !projectConfigFile.deleted && projectConfig) return;
    void ensureProjectConfig({ projectId }).catch(() => {
      // Non-fatal: the descriptor backfills opportunistically.
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

          {tab === "archive" && <ArchivePanel archive={archive} />}
        </div>
      </form>
    </div>
  );
}

// The Archive tab: archived todos with per-row unarchive/delete, plus a
// two-click "Delete all" (it's irreversible beyond the undo toast). Replaces
// the old header-triggered Archived side sheets. The armed delete-all
// confirmation resets whenever the tab unmounts (tab switch or dialog close).
function ArchivePanel({ archive }: { archive?: ProjectArchive }) {
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const todos = archive?.todos ?? [];

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            Todos ({todos.length})
          </h3>
          {todos.length > 0 && archive && (
            <Button
              type="button"
              variant={confirmingDeleteAll ? "destructive" : "outline"}
              size="sm"
              onClick={() => {
                if (confirmingDeleteAll) {
                  archive.onDeleteAllTodos();
                  setConfirmingDeleteAll(false);
                } else {
                  setConfirmingDeleteAll(true);
                }
              }}
            >
              <Trash2Icon />
              {confirmingDeleteAll
                ? `Delete all ${todos.length}? Click to confirm`
                : "Delete all"}
            </Button>
          )}
        </div>
        <ArchivedList items={todos} />
      </section>
    </div>
  );
}

function ArchivedList({ items }: { items: ArchivedItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing archived.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.key}
          className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.title}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.detail}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={item.onUnarchive}
          >
            <ArchiveRestoreIcon />
            Unarchive
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={item.onDelete}
          >
            <Trash2Icon />
            Delete
          </Button>
        </div>
      ))}
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
