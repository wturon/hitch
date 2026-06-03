"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Code2Icon,
  DownloadIcon,
  InfoIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUpdater } from "@/components/UpdateBanner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Harness = "codex" | "claude-code";

interface HarnessHookStatus {
  harness: Harness;
  installed: boolean;
  configPath: string | null;
  scriptPath: string | null;
  configExists: boolean;
  configHasHook: boolean;
  scriptExists: boolean;
  configWired: boolean;
}

interface GlobalHarnessSetupStatus {
  codex: HarnessHookStatus;
  claudeCode: HarnessHookStatus;
}

interface HitchDaemonApi {
  getGlobalHarnessSetup: () => Promise<GlobalHarnessSetupStatus>;
  installGlobalCodexHooks: () => Promise<GlobalHarnessSetupStatus>;
  removeGlobalCodexHooks: () => Promise<GlobalHarnessSetupStatus>;
  installGlobalClaudeHooks: () => Promise<GlobalHarnessSetupStatus>;
  removeGlobalClaudeHooks: () => Promise<GlobalHarnessSetupStatus>;
  openGlobalCodexHookTrust: () => Promise<string>;
}

export function GlobalSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bridge =
    typeof window !== "undefined"
      ? (window.hitchDaemon as unknown as HitchDaemonApi | undefined)
      : undefined;
  const [setup, setSetup] = useState<GlobalHarnessSetupStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!bridge) return;
    setRefreshing(true);
    setError(null);
    try {
      setSetup(await bridge.getGlobalHarnessSetup());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [bridge, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Harness settings</DialogTitle>
          <DialogDescription>
            Manage user-level lifecycle hooks for the coding harnesses Hitch can
            launch.
          </DialogDescription>
        </DialogHeader>

        {!bridge ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            Global settings are only available inside Hitch Desktop.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex gap-3 rounded-lg border bg-muted/35 px-3 py-2.5 text-sm">
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="leading-5 text-muted-foreground">
                These hooks let Hitch track chat lifecycle events and show live
                working or waiting states on task cards. They only update task
                frontmatter inside enabled Hitch folders.
              </p>
            </div>

            <HookSection
              title="Codex chat status hooks"
              harnessLabel="Codex"
              description="User-level Codex hook script and config entries."
              status={setup?.codex ?? null}
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              install={() => bridge.installGlobalCodexHooks()}
              remove={() => bridge.removeGlobalCodexHooks()}
              trust={() => bridge.openGlobalCodexHookTrust()}
              onResult={setSetup}
              onError={setError}
            />

            <HookSection
              title="Claude Code chat status hooks"
              harnessLabel="Claude Code"
              description="User-level Claude Code hook script and config entries."
              status={setup?.claudeCode ?? null}
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              install={() => bridge.installGlobalClaudeHooks()}
              remove={() => bridge.removeGlobalClaudeHooks()}
              onResult={setSetup}
              onError={setError}
            />

            <UpdatesSection />

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UpdatesSection() {
  const { status, check, download, install } = useUpdater();

  const phase = status?.phase ?? "idle";
  const busy = phase === "checking" || phase === "downloading";
  const enabled = status?.enabled ?? false;

  const version = status?.version ?? null;
  const versionLabel = version ? `v${version}` : "a new version";

  function detail(): string {
    if (!status) return "Loading update status…";
    if (!status.enabled) {
      return "Automatic updates aren't available in this build.";
    }
    switch (status.phase) {
      case "checking":
        return "Checking for updates…";
      case "available":
        return `Hitch ${versionLabel} is available.`;
      case "downloading":
        return `Downloading ${versionLabel}… ${status.percent ?? 0}%`;
      case "downloaded":
        return `Hitch ${versionLabel} is ready — restart to install.`;
      case "up-to-date":
        return "Hitch is up to date.";
      case "error":
        return status.error ?? "Update check failed.";
      default:
        return "Check for a newer version of Hitch.";
    }
  }

  // The primary action mirrors the sidebar banner: download when an update is
  // waiting, restart when one is downloaded, otherwise a plain check.
  let action = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled || busy}
      onClick={check}
    >
      <RefreshCwIcon />
      {phase === "checking" ? "Checking…" : "Check for updates"}
    </Button>
  );
  if (phase === "available") {
    action = (
      <Button type="button" size="sm" onClick={download}>
        <DownloadIcon />
        Download
      </Button>
    );
  } else if (phase === "downloading") {
    action = (
      <Button type="button" size="sm" disabled>
        <DownloadIcon />
        Downloading…
      </Button>
    );
  } else if (phase === "downloaded") {
    action = (
      <Button type="button" size="sm" onClick={install}>
        <RotateCwIcon />
        Restart to install
      </Button>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">App updates</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {status
              ? `You're running Hitch v${status.currentVersion}.`
              : "Hitch checks for updates automatically."}
          </p>
        </div>
        {action}
      </div>
      <div className="flex min-h-12 items-center gap-3 rounded-md border bg-background px-3 py-2">
        {phase === "error" ? (
          <AlertCircleIcon className="size-4 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2Icon className="size-4 shrink-0 text-emerald-500" />
        )}
        <p className="text-sm text-muted-foreground">{detail()}</p>
      </div>
    </section>
  );
}

function HookSection({
  title,
  harnessLabel,
  description,
  status,
  refreshing,
  onRefresh,
  install,
  remove,
  trust,
  onResult,
  onError,
}: {
  title: string;
  harnessLabel: string;
  description: string;
  status: HarnessHookStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  install: () => Promise<GlobalHarnessSetupStatus>;
  remove: () => Promise<GlobalHarnessSetupStatus>;
  trust?: () => Promise<string>;
  onResult: (setup: GlobalHarnessSetupStatus) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<"install" | "remove" | "trust" | null>(null);
  const disabled = busy !== null || refreshing;

  const hasFootprint =
    Boolean(status?.scriptExists) || Boolean(status?.configHasHook);
  const installLabel = status?.installed
    ? "Repair"
    : hasFootprint
      ? "Heal"
      : "Install";
  const removeLabel = status?.installed ? "Turn off" : "Delete";

  async function runSetup(
    action: "install" | "remove",
    fn: () => Promise<GlobalHarnessSetupStatus>,
  ) {
    setBusy(action);
    onError("");
    try {
      onResult(await fn());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTrust() {
    if (!trust) return;
    setBusy("trust");
    onError("");
    try {
      await trust();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={onRefresh}
          aria-label="Refresh global settings"
        >
          <RefreshCwIcon />
        </Button>
      </div>

      {status === null ? (
        <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
          Checking {harnessLabel} hook setup...
        </p>
      ) : (
        <HookStatusRow
          status={status}
          title={harnessLabel}
          detail={hookDetail(status)}
          action={
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              <Button
                type="button"
                variant={status.installed ? "outline" : "default"}
                size="sm"
                disabled={disabled}
                onClick={() => void runSetup("install", install)}
              >
                {status.installed ? <WrenchIcon /> : <PowerIcon />}
                {busy === "install" ? "Working..." : installLabel}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={!hasFootprint || disabled}
                onClick={() => void runSetup("remove", remove)}
              >
                {status.installed ? <PowerIcon /> : <Trash2Icon />}
                {busy === "remove" ? "Removing..." : removeLabel}
              </Button>
              {trust && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!status.installed || disabled}
                  onClick={() => void runTrust()}
                >
                  <ShieldCheckIcon />
                  {busy === "trust" ? "Opening..." : "Trust"}
                </Button>
              )}
            </div>
          }
        />
      )}

      {status?.configPath && <PathLine label="Config" value={status.configPath} />}
      {status?.scriptPath && <PathLine label="Script" value={status.scriptPath} />}
    </section>
  );
}

function HookStatusRow({
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
      <Code2Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          <span
            className={[
              "rounded-full px-2 py-0.5 text-[0.7rem] font-medium",
              status.installed
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : status.scriptExists || status.configHasHook
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "bg-muted text-muted-foreground",
            ].join(" ")}
          >
            {status.installed
              ? "On"
              : status.scriptExists || status.configHasHook
                ? "Needs repair"
                : "Off"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-md border bg-background px-3 py-2 sm:grid-cols-[4rem_minmax(0,1fr)]">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="truncate text-xs text-muted-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

function hookDetail(status: HarnessHookStatus): string {
  if (status.installed) {
    return "User-level lifecycle hooks are installed and active";
  }
  if (!status.scriptExists && !status.configHasHook) {
    return "Hook script and user config entries are not installed";
  }
  if (!status.scriptExists) return "Global hook script is missing";
  if (!status.configHasHook) return "User config is not wired";
  if (!status.configWired) return "Some user config entries are missing";
  return "Hooks need repair";
}
