"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Code2Icon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
          <DialogTitle>Global settings</DialogTitle>
          <DialogDescription>
            Configure user-level integrations that apply across Hitch projects.
          </DialogDescription>
        </DialogHeader>

        {!bridge ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            Global settings are only available inside Hitch Desktop.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <HookSection
              title="Codex chat status hooks"
              harnessLabel="Codex"
              description="Installs a user-level Codex hook that updates Hitch task frontmatter only inside enabled Hitch folders."
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
              description="Installs a user-level Claude Code hook that updates Hitch task frontmatter only inside enabled Hitch folders."
              status={setup?.claudeCode ?? null}
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              install={() => bridge.installGlobalClaudeHooks()}
              remove={() => bridge.removeGlobalClaudeHooks()}
              onResult={setSetup}
              onError={setError}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
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
    Boolean(status?.scriptExists) || Boolean(status?.configWired);
  const installLabel = status?.installed || hasFootprint ? "Repair" : "Enable";

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
                variant={status.installed ? "ghost" : "outline"}
                size="sm"
                disabled={disabled}
                onClick={() => void runSetup("install", install)}
              >
                {busy === "install" ? "Installing..." : installLabel}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasFootprint || disabled}
                onClick={() => void runSetup("remove", remove)}
              >
                {busy === "remove" ? "Disabling..." : "Disable"}
              </Button>
              {trust && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!status.installed || disabled}
                  onClick={() => void runTrust()}
                >
                  <TerminalIcon />
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
        <p className="text-sm font-medium">{title}</p>
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
  if (status.installed) return "User-level lifecycle hooks are installed";
  if (!status.scriptExists && !status.configWired) {
    return "Global hook script and user config entries are missing";
  }
  if (!status.scriptExists) return "Global hook script is missing";
  if (!status.configWired) return "User config is not wired";
  return "Hooks need repair";
}
