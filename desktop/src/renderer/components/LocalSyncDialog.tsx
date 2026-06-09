"use client";

import { useEffect, useRef, useState } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { CircleIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type DaemonStatus = "running" | "stopped" | "starting" | "stopping";

interface LogEntry {
  id: number;
  at: string;
  stream: "system" | "stdout" | "stderr";
  message: string;
}

interface DaemonState {
  status: DaemonStatus;
  pid: number | null;
  repoRoot: string;
  configPath: string;
  logs: LogEntry[];
}

export interface HitchBinding {
  projectId: Id<"projects">;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

export interface LocalHitchConfig {
  hitches: HitchBinding[];
}

interface AddHitchInput {
  projectId: Id<"projects">;
  projectName?: string;
  localPath: string;
  updateGitignore?: boolean;
}

interface AddHitchResult {
  config: LocalHitchConfig;
  gitignoreUpdated: boolean;
  restarted: boolean;
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
  getState: () => Promise<DaemonState>;
  start: () => Promise<DaemonState>;
  stop: () => Promise<DaemonState>;
  clearLogs: () => Promise<DaemonState>;
  getConfig: () => Promise<LocalHitchConfig>;
  addHitch: (input: AddHitchInput) => Promise<AddHitchResult>;
  removeHitch: (projectId: Id<"projects">) => Promise<RemoveHitchResult>;
  getProjectSetup: (projectId: Id<"projects">) => Promise<ProjectSetupStatus>;
  ensureHitchDirectory: (
    projectId: Id<"projects">,
  ) => Promise<ProjectSetupStatus>;
  ensureGitignore: (projectId: Id<"projects">) => Promise<ProjectSetupStatus>;
  chooseLocalPath: (defaultPath?: string) => Promise<string | null>;
  getDeviceAuth: () => Promise<{
    deviceId: string;
    deviceName: string;
    hostname: string;
    hasToken: boolean;
  }>;
  setDeviceToken: (token: string) => Promise<{
    deviceId: string;
    deviceName: string;
    hostname: string;
    hasToken: boolean;
  }>;
  onState: (callback: (state: DaemonState) => void) => () => void;
}

declare global {
  interface Window {
    hitchDaemon?: HitchDaemonApi;
  }
}

const emptyState: DaemonState = {
  status: "stopped",
  pid: null,
  repoRoot: "",
  configPath: "",
  logs: [],
};

const emptyConfig: LocalHitchConfig = {
  hitches: [],
};

function hitchPathFromLocalPath(localPath: string) {
  return `${localPath.replace(/[\\/]+$/, "")}/.hitch`;
}

function StatusPill({ status }: { status: DaemonStatus }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs font-medium">
      <CircleIcon
        className={cn(
          "size-2 fill-current",
          status === "running" && "text-emerald-500",
          (status === "starting" || status === "stopping") && "text-amber-500",
          status === "stopped" && "text-muted-foreground",
        )}
      />
      {label}
    </span>
  );
}

export function LocalSyncDialog({
  open,
  onOpenChange,
  onConfigChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigChange?: (config: LocalHitchConfig) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Local sync</DialogTitle>
          <DialogDescription>
            Monitor the sync daemon and every project folder it&apos;s watching.
            Add or remove folders from a project&apos;s settings.
          </DialogDescription>
        </DialogHeader>

        <LocalSyncPanel active={open} onConfigChange={onConfigChange} />
      </DialogContent>
    </Dialog>
  );
}

export function LocalSyncPanel({
  active,
  onConfigChange,
}: {
  active: boolean;
  onConfigChange?: (config: LocalHitchConfig) => void;
}) {
  const bridge = typeof window !== "undefined" ? window.hitchDaemon : undefined;
  const [daemon, setDaemon] = useState<DaemonState>(emptyState);
  const [config, setConfig] = useState<LocalHitchConfig>(emptyConfig);
  const [removingProjectId, setRemovingProjectId] =
    useState<Id<"projects"> | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bridge || !active) return;
    void bridge.getState().then(setDaemon);
    void bridge.getConfig().then((next) => {
      setConfig(next);
      onConfigChange?.(next);
    });
    return bridge.onState(setDaemon);
  }, [active, bridge, onConfigChange]);

  useEffect(() => {
    if (active) logEndRef.current?.scrollIntoView({ block: "end" });
  }, [active, daemon.logs.length]);

  const isBusy = daemon.status === "starting" || daemon.status === "stopping";
  const isRunning = daemon.status === "running";
  const hitches = config.hitches;

  async function unhitchProject(hitch: HitchBinding) {
    if (!bridge) return;
    const label = hitch.projectName || hitch.projectId;
    const confirmed = window.confirm(
      `Unhitch ${label} from this machine? Local .hitch files and .gitignore will be left unchanged.`,
    );
    if (!confirmed) return;

    setRemovingProjectId(hitch.projectId);
    setConfigError(null);
    try {
      const result = await bridge.removeHitch(hitch.projectId);
      setConfig(result.config);
      onConfigChange?.(result.config);
      void bridge.getState().then(setDaemon);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingProjectId(null);
    }
  }

  return !bridge ? (
    <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
      Local sync controls are only available inside Hitch Desktop.
    </p>
  ) : (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Daemon</p>
            <div className="mt-1">
              <StatusPill status={daemon.status} />
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">PID</p>
            <p className="mt-2 truncate text-sm font-medium">
              {daemon.pid ?? "none"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Config</p>
            <p
              className="mt-2 truncate text-sm font-medium"
              title={daemon.configPath}
            >
              {daemon.configPath || "Unknown"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={!bridge || isRunning || isBusy}
            onClick={() => void bridge.start().then(setDaemon)}
          >
            <PlayIcon />
            Start
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!bridge || !isRunning || isBusy}
            onClick={() => void bridge.stop().then(setDaemon)}
          >
            <SquareIcon />
            Stop
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!bridge || daemon.logs.length === 0}
            onClick={() => void bridge.clearLogs().then(setDaemon)}
          >
            <Trash2Icon />
            Clear logs
          </Button>
        </div>

        <div className="rounded-lg border">
          <div className="border-b px-3 py-2">
            <h3 className="text-sm font-medium">Daemon logs</h3>
          </div>
          <div className="max-h-72 overflow-auto p-3 font-mono text-xs">
            {daemon.logs.length === 0 ? (
              <p className="font-sans text-sm text-muted-foreground">
                No daemon output yet.
              </p>
            ) : (
              daemon.logs.map((entry) => (
                <div
                  className="grid grid-cols-[4.5rem_4rem_minmax(0,1fr)] gap-2 py-0.5"
                  key={entry.id}
                >
                  <time className="text-muted-foreground">{entry.at}</time>
                  <span className="text-muted-foreground">{entry.stream}</span>
                  <pre className="min-w-0 whitespace-pre-wrap break-words">
                    {entry.message}
                  </pre>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Watched folders
          </p>
          {hitches.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No folders are hitched yet. Bind one from a project&apos;s
              settings.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {hitches.map((hitch) => (
                <li
                  key={hitch.projectId}
                  className={cn(
                    "rounded-md border bg-background px-3 py-2 text-sm",
                    !hitch.enabled && "opacity-60",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className="min-w-0 flex-1 truncate font-medium"
                      title={hitch.projectName || hitch.projectId}
                    >
                      {hitch.projectName || hitch.projectId}
                    </p>
                    {!hitch.enabled && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        Disabled
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={removingProjectId === hitch.projectId}
                      onClick={() => void unhitchProject(hitch)}
                      aria-label={`Unhitch ${hitch.projectName || hitch.projectId}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <p
                    className="truncate text-muted-foreground"
                    title={hitch.localPath}
                  >
                    {hitch.localPath}
                  </p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={hitchPathFromLocalPath(hitch.localPath)}
                  >
                    {hitchPathFromLocalPath(hitch.localPath)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {configError && (
            <p className="mt-2 text-sm text-destructive">{configError}</p>
          )}
        </div>
      </section>
    </div>
  );
}
