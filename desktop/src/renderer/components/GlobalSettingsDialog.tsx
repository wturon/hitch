"use client";

import { useEffect, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Code2Icon,
  DownloadIcon,
  FlaskConicalIcon,
  FolderSyncIcon,
  InfoIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  defaultEnvironment,
  environmentLabel,
  environmentOptions,
  harnessLabel,
  isEnvironment,
  T3CODE_BLOCKED_REASON,
  type Environment,
} from "@/lib/chat";
import { DeviceTokensPanel } from "@/components/DeviceTokens";
import { HarnessIcon } from "@/components/HarnessIcon";
import { StartingPromptsPanel } from "@/components/StartingPromptsPanel";
import {
  LocalSyncPanel,
  type LocalHitchConfig,
} from "@/components/LocalSyncDialog";
import { useUpdater } from "@/components/UpdateBanner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Harness = "codex" | "claude-code";

export interface HarnessHookStatus {
  harness: Harness;
  installed: boolean;
  configPath: string | null;
  scriptPath: string | null;
  configExists: boolean;
  configHasHook: boolean;
  scriptExists: boolean;
  configWired: boolean;
}

export interface GlobalHarnessSetupStatus {
  codex: HarnessHookStatus;
  claudeCode: HarnessHookStatus;
}

export type GlobalSettingsTab =
  | "harnesses"
  | "starting-prompts"
  | "local-sync"
  | "device-tokens"
  | "updates";

const TABS = [
  { id: "harnesses", label: "Harness settings", icon: Code2Icon },
  { id: "starting-prompts", label: "Starting prompts", icon: MessageSquareIcon },
  { id: "local-sync", label: "Local sync logs", icon: FolderSyncIcon },
  { id: "device-tokens", label: "Device tokens", icon: KeyRoundIcon },
  { id: "updates", label: "App updates", icon: RotateCwIcon },
] as const satisfies ReadonlyArray<{
  id: GlobalSettingsTab;
  label: string;
  icon: typeof Code2Icon;
}>;

interface HitchDaemonApi {
  getGlobalHarnessSetup: () => Promise<GlobalHarnessSetupStatus>;
  installGlobalCodexHooks: () => Promise<GlobalHarnessSetupStatus>;
  removeGlobalCodexHooks: () => Promise<GlobalHarnessSetupStatus>;
  installGlobalClaudeHooks: () => Promise<GlobalHarnessSetupStatus>;
  removeGlobalClaudeHooks: () => Promise<GlobalHarnessSetupStatus>;
  openGlobalCodexHookTrust: () => Promise<string>;
  getHarnessEnvironments: () => Promise<Record<string, string>>;
  setHarnessEnvironment: (
    harness: string,
    environment: string,
  ) => Promise<Record<string, string>>;
  getExperimentalFlags: () => Promise<Record<string, boolean>>;
  setExperimentalFlag: (
    key: string,
    enabled: boolean,
  ) => Promise<Record<string, boolean>>;
}

// Each harness Hitch can drive renders as one card: a branded header plus its
// environment and status-hook rows. New harnesses drop in by adding an entry
// here — the bridge methods are the only per-harness wiring.
const HARNESS_CARDS: ReadonlyArray<{
  harness: Harness;
  subtitle: string;
  statusKey: keyof GlobalHarnessSetupStatus;
  install: (bridge: HitchDaemonApi) => Promise<GlobalHarnessSetupStatus>;
  remove: (bridge: HitchDaemonApi) => Promise<GlobalHarnessSetupStatus>;
  trust?: (bridge: HitchDaemonApi) => Promise<string>;
}> = [
  {
    harness: "claude-code",
    subtitle: "Anthropic coding agent",
    statusKey: "claudeCode",
    install: (bridge) => bridge.installGlobalClaudeHooks(),
    remove: (bridge) => bridge.removeGlobalClaudeHooks(),
  },
  {
    harness: "codex",
    subtitle: "OpenAI coding agent",
    statusKey: "codex",
    install: (bridge) => bridge.installGlobalCodexHooks(),
    remove: (bridge) => bridge.removeGlobalCodexHooks(),
    trust: (bridge) => bridge.openGlobalCodexHookTrust(),
  },
];

export function GlobalSettingsDialog({
  open,
  onOpenChange,
  initialTab = "harnesses",
  onLocalConfigChange,
  onHarnessSetupChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: GlobalSettingsTab;
  onLocalConfigChange?: (config: LocalHitchConfig) => void;
  onHarnessSetupChange?: (setup: GlobalHarnessSetupStatus) => void;
}) {
  const bridge =
    typeof window !== "undefined"
      ? (window.hitchDaemon as unknown as HitchDaemonApi | undefined)
      : undefined;
  const [tab, setTab] = useState<GlobalSettingsTab>(initialTab);
  const [setup, setSetup] = useState<GlobalHarnessSetupStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // T3Code remains visibly listed below, but is hard-locked off until the
  // upstream app exposes a supported way to focus a specific chat.
  const [t3codeEnabled, setT3codeEnabled] = useState(false);

  useEffect(() => {
    if (!open || !bridge?.getExperimentalFlags) return;
    void bridge
      .getExperimentalFlags()
      .then(() => setT3codeEnabled(false))
      .catch(() => {});
  }, [open, bridge]);

  async function toggleT3code(_enabled: boolean) {
    setT3codeEnabled(false);
    if (!bridge?.setExperimentalFlag) return;
    try {
      await bridge.setExperimentalFlag("t3code", false);
    } catch {
      setT3codeEnabled(false);
    }
  }

  function receiveSetup(next: GlobalHarnessSetupStatus) {
    setSetup(next);
    onHarnessSetupChange?.(next);
  }

  async function refresh() {
    if (!bridge) return;
    setRefreshing(true);
    setError(null);
    try {
      receiveSetup(await bridge.getGlobalHarnessSetup());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    void refresh();
  }, [bridge, initialTab, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[660px] max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Global settings</DialogTitle>
          <DialogDescription>
            Manage Hitch Desktop, local sync, and user-level harness setup.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
          <nav className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto">
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
                <span className="min-w-0 truncate">{label}</span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {tab === "harnesses" && (
              <div className="flex flex-col gap-3">
                {!bridge ? (
                  <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                    Harness settings are only available inside Hitch Desktop.
                  </p>
                ) : (
                  <>
                    <div className="flex items-start gap-2">
                      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                      <p className="text-xs leading-5 text-muted-foreground">
                        Choose where Hitch runs each agent and let it install the
                        status hooks that surface live working / waiting states on
                        task cards. Hooks only update task frontmatter inside
                        enabled Hitch folders.
                      </p>
                    </div>

                    {HARNESS_CARDS.map((card) => (
                      <HarnessCard
                        key={card.harness}
                        harness={card.harness}
                        subtitle={card.subtitle}
                        bridge={bridge}
                        experimentalT3Code={t3codeEnabled}
                        status={setup?.[card.statusKey] ?? null}
                        refreshing={refreshing}
                        onRefresh={() => void refresh()}
                        install={() => card.install(bridge)}
                        remove={() => card.remove(bridge)}
                        trust={
                          card.trust ? () => card.trust!(bridge) : undefined
                        }
                        onResult={receiveSetup}
                        onError={setError}
                      />
                    ))}

                    <ExperimentalSection
                      t3codeEnabled={t3codeEnabled}
                      onToggleT3code={(next) => void toggleT3code(next)}
                    />

                    {error && (
                      <p className="text-sm text-destructive">{error}</p>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === "starting-prompts" && <StartingPromptsPanel />}

            {tab === "local-sync" && (
              <div className="flex flex-col gap-3">
                <div>
                  <h3 className="text-sm font-medium">Local sync logs</h3>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    Monitor the daemon and the folders it is watching.
                  </p>
                </div>
                <LocalSyncPanel
                  active={open && tab === "local-sync"}
                  onConfigChange={onLocalConfigChange}
                />
              </div>
            )}

            {tab === "device-tokens" && (
              <div className="flex flex-col gap-3">
                <div>
                  <h3 className="text-sm font-medium">Device tokens</h3>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    Create and revoke tokens for local daemons.
                  </p>
                </div>
                <DeviceTokensPanel />
              </div>
            )}

            {tab === "updates" && <UpdatesSection />}
          </div>
        </div>
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

// One card per harness: a branded header that owns the harness identity, with
// the environment and status-hook rows nested inside so they clearly roll up to
// their parent. All behavior lives in the child rows — this is layout only.
function HarnessCard({
  harness,
  subtitle,
  bridge,
  experimentalT3Code,
  status,
  refreshing,
  onRefresh,
  install,
  remove,
  trust,
  onResult,
  onError,
}: {
  harness: Harness;
  subtitle: string;
  bridge: HitchDaemonApi | undefined;
  experimentalT3Code: boolean;
  status: HarnessHookStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  install: () => Promise<GlobalHarnessSetupStatus>;
  remove: () => Promise<GlobalHarnessSetupStatus>;
  trust?: () => Promise<string>;
  onResult: (setup: GlobalHarnessSetupStatus) => void;
  onError: (message: string) => void;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b bg-muted/30 px-3.5 py-3">
        <HarnessIcon harness={harness} className="size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-tight">
            {harnessLabel(harness)}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <OverallStatusPill status={status} />
      </div>
      <EnvironmentRow
        harness={harness}
        bridge={bridge}
        experimentalT3Code={experimentalT3Code}
      />
      <HookSection
        harnessLabel={harnessLabel(harness)}
        status={status}
        refreshing={refreshing}
        onRefresh={onRefresh}
        install={install}
        remove={remove}
        trust={trust}
        onResult={onResult}
        onError={onError}
      />
    </section>
  );
}

// At-a-glance harness health, shown in the card header. Driven by hook state
// today; the harness-level framing leaves room for other signals later.
function OverallStatusPill({ status }: { status: HarnessHookStatus | null }) {
  const tone = !status
    ? "checking"
    : status.installed
      ? "active"
      : status.scriptExists || status.configHasHook
        ? "repair"
        : "off";
  const label = {
    checking: "Checking…",
    active: "Active",
    repair: "Needs repair",
    off: "Not set up",
  }[tone];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "active"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : tone === "repair"
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "active"
            ? "bg-emerald-500"
            : tone === "repair"
              ? "bg-amber-500"
              : "bg-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

// Where Hitch opens this harness's sessions. The choice persists to a local
// preferences file the daemon reads to pick the launcher; an unset preference
// falls back to the harness default, so existing behavior is unchanged.
function EnvironmentRow({
  harness,
  bridge,
  experimentalT3Code,
}: {
  harness: Harness;
  bridge: HitchDaemonApi | undefined;
  experimentalT3Code: boolean;
}) {
  const options = environmentOptions(harness, { experimentalT3Code });
  const [value, setValue] = useState<Environment>(defaultEnvironment(harness));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge
      .getHarnessEnvironments()
      .then((map) => {
        const stored = map[harness];
        if (stored === "t3code") {
          setValue(defaultEnvironment(harness));
        } else if (stored && isEnvironment(stored)) {
          setValue(stored);
        }
      })
      .catch(() => {});
  }, [bridge, harness]);

  async function change(next: Environment) {
    setValue(next);
    if (!bridge) return;
    setSaving(true);
    try {
      await bridge.setHarnessEnvironment(harness, next);
    } finally {
      setSaving(false);
    }
  }

  // Only the single-option harnesses lock the select; otherwise it's a real choice.
  const locked = options.length < 2 || !bridge;

  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.8rem] font-medium">Environment</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Where Hitch opens and resumes sessions.
          </p>
        </div>
        <Select
          value={value}
          onValueChange={(next) => void change(next as Environment)}
          disabled={locked || saving}
        >
          <SelectTrigger
            className="w-48"
            aria-label={`${harnessLabel(harness)} run environment`}
          >
            <SelectValue>
              {(env: Environment) => environmentLabel(env)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value === "t3code" ? (
        // Focus depends on launch ownership — be explicit so degraded focus
        // doesn't read as a bug (see the daemon's t3code.ts).
        <p className="text-xs text-amber-600 dark:text-amber-400/90">
          Experimental: Hitch creates chats in T3Code over its local API and can
          bring a specific thread to the front. Automatic thread focus works only
          when <span className="font-medium">Hitch launched T3Code</span> (we
          attach over a local debug pipe — no network port is opened, and only
          Hitch can use it). If you opened T3Code yourself, Hitch brings the
          window forward but can't jump to the thread; you'll get a hint to click
          it. A stopgap until T3Code ships a supported focus API.
        </p>
      ) : harness === "claude-code" &&
        (value === "vscode" || value === "cursor") ? (
        // Claude in an editor extension is fire-and-forget: we pre-fill the
        // prompt via the URI and the user submits it. Codex editors don't apply —
        // there Hitch drives the run through the app server and auto-submits.
        <p className="text-xs text-amber-600 dark:text-amber-400/90">
          Experimental: opens the {environmentLabel(value)} with your prompt
          pre-filled — press Enter to start. The card links once you send the
          first message, then tracks status normally.
        </p>
      ) : value === "vscode" || value === "cursor" ? null : (
        <p className="text-xs text-muted-foreground/70">
          More environments are coming.
        </p>
      )}
    </div>
  );
}

// Opt-in experimental features. Today just the T3Code environment; the toggle
// adds T3Code to every harness's Environment dropdown above. Kept visually quiet
// (amber, "experimental") so it reads as opt-in, not a finished feature.
function ExperimentalSection({
  t3codeEnabled,
  onToggleT3code,
}: {
  t3codeEnabled: boolean;
  onToggleT3code: (enabled: boolean) => void;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b bg-muted/30 px-3.5 py-3">
        <FlaskConicalIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-tight">Experimental</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Opt-in features that may change or break.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[0.8rem] font-medium">T3Code environment</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {T3CODE_BLOCKED_REASON}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          disabled
          aria-pressed={false}
          onClick={() => onToggleT3code(!t3codeEnabled)}
        >
          Off
        </Button>
      </div>
    </section>
  );
}

// The status-hook row of a harness card. Owns install / repair / heal / remove
// / trust / refresh — all unchanged from before; only the surrounding layout
// moved from a standalone section into a nested card row.
function HookSection({
  harnessLabel,
  status,
  refreshing,
  onRefresh,
  install,
  remove,
  trust,
  onResult,
  onError,
}: {
  harnessLabel: string;
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

  const refreshButton = (
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
  );

  if (status === null) {
    return (
      <div className="flex items-center justify-between gap-2 border-t px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[0.8rem] font-medium">Status hooks</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Checking {harnessLabel} hook setup…
          </p>
        </div>
        {refreshButton}
      </div>
    );
  }

  const pillTone = status.installed
    ? "on"
    : hasFootprint
      ? "repair"
      : "off";

  return (
    <div className="flex flex-col gap-2.5 border-t px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.8rem] font-medium">Status hooks</p>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[0.7rem] font-medium",
                pillTone === "on"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : pillTone === "repair"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {pillTone === "on"
                ? "Installed"
                : pillTone === "repair"
                  ? "Needs repair"
                  : "Off"}
            </span>
          </div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {hookDetail(status)}
          </p>
        </div>
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
          {refreshButton}
        </div>
      </div>

      {(status.configPath || status.scriptPath) && (
        <div className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2">
          {status.configPath && (
            <PathLine label="Config" value={status.configPath} />
          )}
          {status.scriptPath && (
            <PathLine label="Script" value={status.scriptPath} />
          )}
        </div>
      )}
    </div>
  );
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-12 shrink-0 text-muted-foreground/70">{label}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
        title={value}
      >
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
