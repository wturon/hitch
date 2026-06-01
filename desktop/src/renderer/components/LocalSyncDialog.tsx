"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleIcon,
  FolderPlusIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";

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

interface AddHitchInput {
  project: string;
  projectName?: string;
  localPath: string;
  updateGitignore?: boolean;
}

interface AddHitchResult {
  config: LocalHitchConfig;
  gitignoreUpdated: boolean;
  restarted: boolean;
}

interface HitchDaemonApi {
  getState: () => Promise<DaemonState>;
  start: () => Promise<DaemonState>;
  stop: () => Promise<DaemonState>;
  clearLogs: () => Promise<DaemonState>;
  getConfig: () => Promise<LocalHitchConfig>;
  addHitch: (input: AddHitchInput) => Promise<AddHitchResult>;
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
  activeProject: "",
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
  project,
  open,
  onOpenChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bridge = typeof window !== "undefined" ? window.hitchDaemon : undefined;
  const [daemon, setDaemon] = useState<DaemonState>(emptyState);
  const [config, setConfig] = useState<LocalHitchConfig>(emptyConfig);
  const [projectName, setProjectName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [updateGitignore, setUpdateGitignore] = useState(true);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bridge || !open) return;
    void bridge.getState().then(setDaemon);
    void bridge.getConfig().then((next) => {
      setConfig(next);
      setProjectName(next.hitches.find((hitch) => hitch.project === project)?.projectName ?? "");
    });
    return bridge.onState(setDaemon);
  }, [bridge, open, project]);

  useEffect(() => {
    if (open) logEndRef.current?.scrollIntoView({ block: "end" });
  }, [daemon.logs.length, open]);

  const activeHitch = useMemo(
    () => config.hitches.find((hitch) => hitch.project === config.activeProject),
    [config],
  );
  const isBusy = daemon.status === "starting" || daemon.status === "stopping";
  const isRunning = daemon.status === "running";

  async function submitHitch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bridge) return;
    setFormError("");
    setBusy(true);
    try {
      const result = await bridge.addHitch({
        project,
        projectName,
        localPath,
        updateGitignore,
      });
      setConfig(result.config);
      setLocalPath("");
      setUpdateGitignore(true);
    } catch (err) {
      setFormError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Local sync</DialogTitle>
          <DialogDescription>
            Configure the local folder this desktop app watches for the active project.
          </DialogDescription>
        </DialogHeader>

        {!bridge ? (
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
                  <p className="mt-2 truncate text-sm font-medium">{daemon.pid ?? "none"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Config</p>
                  <p className="mt-2 truncate text-sm font-medium" title={daemon.configPath}>
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
                      <div className="grid grid-cols-[4.5rem_4rem_minmax(0,1fr)] gap-2 py-0.5" key={entry.id}>
                        <time className="text-muted-foreground">{entry.at}</time>
                        <span className="text-muted-foreground">{entry.stream}</span>
                        <pre className="min-w-0 whitespace-pre-wrap break-words">{entry.message}</pre>
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
                  Active hitch
                </p>
                {activeHitch ? (
                  <div className="mt-2 space-y-1 text-sm">
                    <p className="font-medium">{activeHitch.projectName || activeHitch.project}</p>
                    <p className="truncate text-muted-foreground" title={activeHitch.localPath}>
                      {activeHitch.localPath}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={hitchPathFromLocalPath(activeHitch.localPath)}>
                      {hitchPathFromLocalPath(activeHitch.localPath)}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No local folder is configured for this project.
                  </p>
                )}
              </div>

              <form className="flex flex-col gap-3 rounded-lg border p-3" onSubmit={submitHitch}>
                <h3 className="text-sm font-medium">Hitch this project</h3>
                <label className="flex flex-col gap-1.5 text-sm">
                  Local path
                  <input
                    value={localPath}
                    onChange={(event) => setLocalPath(event.target.value)}
                    placeholder="/Users/you/code/project"
                    spellCheck={false}
                    className="h-9 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  Project name
                  <input
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="Optional display name"
                    spellCheck={false}
                    className="h-9 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={updateGitignore}
                    onChange={(event) => setUpdateGitignore(event.target.checked)}
                    className="size-4"
                  />
                  Add .hitch/ to .gitignore
                </label>
                {formError && <p className="text-sm text-destructive">{formError}</p>}
                <Button type="submit" disabled={!bridge || busy}>
                  <FolderPlusIcon />
                  {busy ? "Adding..." : "Add hitch"}
                </Button>
              </form>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
