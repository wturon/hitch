"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import {
  AlertCircleIcon,
  CalendarIcon,
  CheckCircle2Icon,
  Code2Icon,
  FolderOpenIcon,
  HashIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TerminalIcon,
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

const projectDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

type ProjectDetails = NonNullable<FunctionReturnType<typeof api.projects.details>>;

interface HitchBinding {
  project: string;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

interface LocalHitchConfig {
  activeProject: string;
  hitches: HitchBinding[];
}

interface ProjectSetupStatus {
  project: string;
  hitch: HitchBinding | null;
  localPathExists: boolean;
  hitchPath: string | null;
  hitchPathExists: boolean;
  gitignorePath: string | null;
  gitignoreExists: boolean;
  gitignoreHasHitch: boolean;
}

type Harness = "codex" | "claude-code";

interface HarnessHookStatus {
  harness: Harness;
  installed: boolean;
  configPath: string | null;
  scriptPath: string | null;
  configExists: boolean;
  scriptExists: boolean;
  configWired: boolean;
}

interface HarnessSetupStatus {
  project: string;
  hitch: HitchBinding | null;
  localPathExists: boolean;
  codex: HarnessHookStatus;
  claudeCode: HarnessHookStatus;
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
  project,
  open,
  onOpenChange,
  onLocalConfigChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
}) {
  const details = useQuery(api.projects.details, open ? { project } : "skip");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Project details</DialogTitle>
          <DialogDescription>
            {details?.project?.slug ?? project}
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
            project={project}
            details={details}
            onLocalConfigChange={onLocalConfigChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProjectDetailsForm({
  project,
  details,
  onLocalConfigChange,
}: {
  project: string;
  details: ProjectDetails;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
}) {
  const bridge = typeof window !== "undefined" ? window.hitchDaemon : undefined;
  const updateDetails = useMutation(api.projects.updateDetails);
  const [name, setName] = useState(details.project.name);
  const [setup, setSetup] = useState<ProjectSetupStatus | null>(null);
  const [harnessSetup, setHarnessSetup] = useState<HarnessSetupStatus | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [harnessBusy, setHarnessBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [harnessError, setHarnessError] = useState<string | null>(null);
  const canEdit = details.membership?.role === "owner";
  const trimmedName = name.trim();
  const hasNameChange = trimmedName !== details.project.name;

  async function refreshSetup() {
    if (!bridge) return;
    const [next, nextHarnessSetup] = await Promise.all([
      bridge.getProjectSetup(project),
      bridge.getHarnessSetup(project),
    ]);
    setSetup(next);
    setHarnessSetup(nextHarnessSetup);
    setLocalPath(next.hitch?.localPath ?? "");
  }

  useEffect(() => {
    void refreshSetup().catch((err) => {
      setSetupError(err instanceof Error ? err.message : String(err));
    });
  }, [bridge, project]);

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !trimmedName || !hasNameChange) return;

    setSaving(true);
    setError(null);
    try {
      await updateDetails({ project, name: trimmedName });
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
      const result = await bridge.addHitch({
        project,
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

  async function repairSetup(action: "hitch" | "gitignore") {
    if (!bridge) return;
    setSetupBusy(action);
    setSetupError(null);
    try {
      const next =
        action === "hitch"
          ? await bridge.ensureHitchDirectory(project)
          : await bridge.ensureGitignore(project);
      setSetup(next);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupBusy(null);
    }
  }

  async function installHarness(harness: Harness) {
    if (!bridge) return;
    setHarnessBusy(harness);
    setHarnessError(null);
    try {
      const next = await bridge.installHarnessHooks(project, harness);
      setHarnessSetup(next);
    } catch (err) {
      setHarnessError(err instanceof Error ? err.message : String(err));
    } finally {
      setHarnessBusy(null);
    }
  }

  async function openCodexTrust() {
    if (!bridge) return;
    setHarnessBusy("codex-trust");
    setHarnessError(null);
    try {
      await bridge.openCodexHookTrust(project);
    } catch (err) {
      setHarnessError(err instanceof Error ? err.message : String(err));
    } finally {
      setHarnessBusy(null);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={saveProject}>
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
            Slug
          </div>
          <p className="mt-1 truncate text-sm font-medium">
            {details.project.slug}
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

      <section className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Local setup</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bind this project to a folder and keep its .hitch workspace private.
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
          </div>
        ) : (
          <div className="flex flex-col gap-2">
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

        {setupError && <p className="text-sm text-destructive">{setupError}</p>}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Harness configuration</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Install lifecycle hooks when you want chat cards to show working and waiting states.
            </p>
          </div>
          <Code2Icon className="size-4 shrink-0 text-muted-foreground" />
        </div>

        {!bridge ? (
          <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
            Harness setup is only available inside Hitch Desktop.
          </p>
        ) : setup === null || harnessSetup === null ? (
          <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
            Checking harness setup...
          </p>
        ) : !setup.hitch || !setup.localPathExists ? (
          <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
            Hitch this project to a local folder before installing harness hooks.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <HarnessCheck
              status={harnessSetup.codex}
              title="Codex"
              detail={harnessDetail(harnessSetup.codex)}
              action={
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant={harnessSetup.codex.installed ? "ghost" : "outline"}
                    size="sm"
                    disabled={harnessBusy !== null}
                    onClick={() => void installHarness("codex")}
                  >
                    {harnessBusy === "codex"
                      ? "Installing..."
                      : harnessSetup.codex.installed
                        ? "Repair"
                        : "Install"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!harnessSetup.codex.installed || harnessBusy !== null}
                    onClick={() => void openCodexTrust()}
                  >
                    <TerminalIcon />
                    {harnessBusy === "codex-trust" ? "Opening..." : "Trust"}
                  </Button>
                </div>
              }
            />
            <HarnessCheck
              status={harnessSetup.claudeCode}
              title="Claude Code"
              detail={harnessDetail(harnessSetup.claudeCode)}
              action={
                <Button
                  type="button"
                  variant={harnessSetup.claudeCode.installed ? "ghost" : "outline"}
                  size="sm"
                  disabled={harnessBusy !== null}
                  onClick={() => void installHarness("claude-code")}
                >
                  {harnessBusy === "claude-code"
                    ? "Installing..."
                    : harnessSetup.claudeCode.installed
                      ? "Repair"
                      : "Install"}
                </Button>
              }
            />
          </div>
        )}

        {harnessError && <p className="text-sm text-destructive">{harnessError}</p>}
      </section>

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

      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        <Button
          type="submit"
          disabled={!canEdit || saving || !trimmedName || !hasNameChange}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
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

function harnessDetail(status: HarnessHookStatus): string {
  if (status.installed) return "Lifecycle hooks are installed";
  if (!status.scriptExists && !status.configWired) {
    return "Hook script and config entries are missing";
  }
  if (!status.scriptExists) return "Hook script is missing";
  if (!status.configWired) return "Hook config is not wired";
  return "Lifecycle hooks need repair";
}

function HarnessCheck({
  status,
  title,
  detail,
  action,
}: {
  status: HarnessHookStatus;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-md border bg-background px-3 py-2">
      {status.installed ? (
        <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
      ) : (
        <AlertCircleIcon className="size-4 shrink-0 text-amber-500" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p
          className="truncate text-xs text-muted-foreground"
          title={status.configPath ?? detail}
        >
          {detail}
        </p>
      </div>
      {action}
    </div>
  );
}
