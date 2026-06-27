import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";

type DaemonStatus = "running" | "stopped" | "starting" | "stopping";
type ProjectId = string;

export interface AuthCallback {
  code?: string;
  error?: string;
}

export interface LogEntry {
  id: number;
  at: string;
  stream: "system" | "stdout" | "stderr";
  message: string;
}

export interface ProjectConflict {
  projectId: ProjectId;
  projectName?: string;
  localPath: string;
  diskProjectId: string;
}

export interface DaemonState {
  status: DaemonStatus;
  pid: number | null;
  repoRoot: string;
  configPath: string;
  logs: LogEntry[];
  conflicts: ProjectConflict[];
}

export interface HitchBinding {
  projectId: ProjectId;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

export interface LocalHitchConfig {
  hitches: HitchBinding[];
}

export interface AddHitchInput {
  projectId: ProjectId;
  projectName?: string;
  localPath: string;
  updateGitignore?: boolean;
}

export interface AddHitchResult {
  config: LocalHitchConfig;
  gitignoreUpdated: boolean;
  restarted: boolean;
}

export interface RemoveHitchResult {
  config: LocalHitchConfig;
  removed: boolean;
  restarted: boolean;
}

export interface ProjectSetupStatus {
  projectId: ProjectId;
  hitch: HitchBinding | null;
  localPathExists: boolean;
  hitchPath: string | null;
  hitchPathExists: boolean;
  gitignorePath: string | null;
  gitignoreExists: boolean;
  gitignoreHasHitch: boolean;
}

export type IntegrationState = "ok" | "missing" | "drifted" | "broken" | "quiet";

export interface IntegrationStatus {
  id: string;
  label: string;
  group: "Codex" | "Claude Code" | "cmux";
  level: "harness" | "environment";
  owner: "hitch" | "delegated";
  applies: boolean;
  state: IntegrationState;
  reason: string;
  targetPaths: string[];
  canRepair: boolean;
  repairLabel: string;
}

export interface IntegrationHealth {
  checkedAt: string;
  integrations: IntegrationStatus[];
}

export type Harness = "codex" | "claude-code";

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

export interface StartingPrompt {
  id: string;
  name: string;
  body: string;
  includeTaskRef: boolean;
}

export interface GlobalHarnessSetupStatus {
  codex: HarnessHookStatus;
  claudeCode: HarnessHookStatus;
}

export interface DeviceAuthState {
  deviceId: string;
  deviceName: string;
  hostname: string;
  hasToken: boolean;
}

export interface KeepAwakeState {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  error: string | null;
}

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterStatus {
  enabled: boolean;
  phase: UpdaterPhase;
  currentVersion: string;
  version: string | null;
  percent: number | null;
  error: string | null;
}

export interface EnableCmuxResult {
  status: "created" | "updated" | "already-enabled";
  configPath: string;
  backupPath?: string;
}

// --- cmux debug screen (local-only data from the daemon) ---
export type CmuxDriftState = "ok" | "multi-surface" | "no-binding" | "closed";

export interface CmuxChatSummary {
  chatId: string | null;
  launchId: string | null;
  harness: string;
  title: string;
  status: string;
  cwd: string;
  host: string;
  pending: boolean;
  lastEventAt: number;
}

export interface CmuxReconcileEntry extends CmuxChatSummary {
  surfaces: string[];
  matchCount: number;
  drift: CmuxDriftState;
}

export interface CmuxReconcileResult {
  scannedAt: number;
  driftCount: number;
  entries: CmuxReconcileEntry[];
}

export interface CmuxTraceRow {
  seq: number;
  ts: number;
  chatId: string | null;
  launchId: string | null;
  kind: "io" | "decision" | "warn";
  command: string | null;
  args: string[] | null;
  durationMs: number | null;
  ok: boolean | null;
  errorCode: string | null;
  message: string | null;
}

export interface HitchDaemonApi {
  getState: () => Promise<DaemonState>;
  start: () => Promise<DaemonState>;
  stop: () => Promise<DaemonState>;
  clearLogs: () => Promise<DaemonState>;
  getConfig: () => Promise<LocalHitchConfig>;
  addHitch: (input: AddHitchInput) => Promise<AddHitchResult>;
  removeHitch: (projectId: ProjectId) => Promise<RemoveHitchResult>;
  resolveProjectConflict: (projectId: ProjectId) => Promise<DaemonState>;
  getProjectSetup: (projectId: ProjectId) => Promise<ProjectSetupStatus>;
  ensureHitchDirectory: (projectId: ProjectId) => Promise<ProjectSetupStatus>;
  ensureGitignore: (projectId: ProjectId) => Promise<ProjectSetupStatus>;
  getGlobalHarnessSetup: () => Promise<GlobalHarnessSetupStatus>;
  checkIntegrations: () => Promise<IntegrationHealth>;
  repairIntegration: (id: string) => Promise<IntegrationHealth>;
  repairAllIntegrations: () => Promise<IntegrationHealth>;
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
  getStartingPrompts: () => Promise<StartingPrompt[]>;
  setStartingPrompts: (prompts: StartingPrompt[]) => Promise<StartingPrompt[]>;
  enableCmuxAutomation: () => Promise<EnableCmuxResult>;
  openCmuxApp: () => Promise<string>;
  listCmuxChats: (projectId: string | null) => Promise<CmuxChatSummary[]>;
  reconcileCmux: (projectId: string | null) => Promise<CmuxReconcileResult>;
  readCmuxTrace: (
    filter?: { chatId?: string | null; launchId?: string | null },
    limit?: number,
  ) => Promise<CmuxTraceRow[]>;
  chooseLocalPath: (defaultPath?: string) => Promise<string | null>;
  getDeviceAuth: () => Promise<DeviceAuthState>;
  setDeviceToken: (token: string) => Promise<DeviceAuthState>;
  clearDeviceToken: () => Promise<DeviceAuthState>;
  getAuthStorageItem: (key: string) => Promise<string | null>;
  setAuthStorageItem: (key: string, value: string) => Promise<void>;
  removeAuthStorageItem: (key: string) => Promise<void>;
  getUpdaterStatus: () => Promise<UpdaterStatus>;
  checkForUpdates: () => Promise<UpdaterStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getKeepAwakeState: () => Promise<KeepAwakeState>;
  startKeepAwake: () => Promise<KeepAwakeState>;
  stopKeepAwake: () => Promise<KeepAwakeState>;
  setNativeTheme: (mode: "light" | "dark" | "system") => Promise<void>;
  copyImageFromUrl: (url: string) => Promise<void>;
  onState: (callback: (state: DaemonState) => void) => () => void;
  onAuthCallback: (callback: (payload: AuthCallback) => void) => () => void;
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => () => void;
  onKeepAwakeState: (callback: (state: KeepAwakeState) => void) => () => void;
}

const api: HitchDaemonApi = {
  getState: () => ipcRenderer.invoke("daemon:get-state"),
  start: () => ipcRenderer.invoke("daemon:start"),
  stop: () => ipcRenderer.invoke("daemon:stop"),
  clearLogs: () => ipcRenderer.invoke("daemon:clear-logs"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  addHitch: (input) => ipcRenderer.invoke("config:add-hitch", input),
  removeHitch: (projectId) => ipcRenderer.invoke("config:remove-hitch", projectId),
  resolveProjectConflict: (projectId) =>
    ipcRenderer.invoke("config:resolve-conflict", projectId),
  getProjectSetup: (projectId) => ipcRenderer.invoke("config:get-project-setup", projectId),
  ensureHitchDirectory: (projectId) => ipcRenderer.invoke("config:ensure-hitch-directory", projectId),
  ensureGitignore: (projectId) => ipcRenderer.invoke("config:ensure-gitignore", projectId),
  getGlobalHarnessSetup: () => ipcRenderer.invoke("config:get-global-harness-setup"),
  checkIntegrations: () => ipcRenderer.invoke("integrations:check"),
  repairIntegration: (id) => ipcRenderer.invoke("integrations:repair", id),
  repairAllIntegrations: () => ipcRenderer.invoke("integrations:repair-all"),
  installGlobalCodexHooks: () =>
    ipcRenderer.invoke("config:install-global-codex-hooks"),
  removeGlobalCodexHooks: () =>
    ipcRenderer.invoke("config:remove-global-codex-hooks"),
  installGlobalClaudeHooks: () =>
    ipcRenderer.invoke("config:install-global-claude-hooks"),
  removeGlobalClaudeHooks: () =>
    ipcRenderer.invoke("config:remove-global-claude-hooks"),
  openGlobalCodexHookTrust: () =>
    ipcRenderer.invoke("config:open-global-codex-hook-trust"),
  getHarnessEnvironments: () =>
    ipcRenderer.invoke("config:get-harness-environments"),
  setHarnessEnvironment: (harness, environment) =>
    ipcRenderer.invoke("config:set-harness-environment", harness, environment),
  getExperimentalFlags: () => ipcRenderer.invoke("config:get-experimental"),
  setExperimentalFlag: (key, enabled) =>
    ipcRenderer.invoke("config:set-experimental", key, enabled),
  getStartingPrompts: () => ipcRenderer.invoke("config:get-starting-prompts"),
  setStartingPrompts: (prompts) =>
    ipcRenderer.invoke("config:set-starting-prompts", prompts),
  enableCmuxAutomation: () => ipcRenderer.invoke("cmux:enable-automation"),
  openCmuxApp: () => ipcRenderer.invoke("cmux:open-app"),
  listCmuxChats: (projectId) => ipcRenderer.invoke("debug:list-cmux-chats", projectId),
  reconcileCmux: (projectId) => ipcRenderer.invoke("debug:reconcile-cmux", projectId),
  readCmuxTrace: (filter, limit) =>
    ipcRenderer.invoke("debug:read-cmux-trace", filter, limit),
  chooseLocalPath: (defaultPath) => ipcRenderer.invoke("dialog:choose-local-path", defaultPath),
  getDeviceAuth: () => ipcRenderer.invoke("device-auth:get"),
  setDeviceToken: (token) => ipcRenderer.invoke("device-auth:set-token", token),
  clearDeviceToken: () => ipcRenderer.invoke("device-auth:clear-token"),
  getAuthStorageItem: (key) => ipcRenderer.invoke("auth-storage:get", key),
  setAuthStorageItem: (key, value) =>
    ipcRenderer.invoke("auth-storage:set", key, value),
  removeAuthStorageItem: (key) =>
    ipcRenderer.invoke("auth-storage:remove", key),
  getUpdaterStatus: () => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  getKeepAwakeState: () => ipcRenderer.invoke("keep-awake:get-state"),
  startKeepAwake: () => ipcRenderer.invoke("keep-awake:start"),
  stopKeepAwake: () => ipcRenderer.invoke("keep-awake:stop"),
  setNativeTheme: (mode) => ipcRenderer.invoke("theme:set-source", mode),
  copyImageFromUrl: (url) => ipcRenderer.invoke("clipboard:copy-image-from-url", url),
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: DaemonState) => {
      callback(state);
    };
    ipcRenderer.on("daemon:state", listener);
    return () => ipcRenderer.removeListener("daemon:state", listener);
  },
  onUpdaterStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: UpdaterStatus) => {
      callback(status);
    };
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  },
  onAuthCallback: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: AuthCallback) => {
      callback(payload);
    };
    ipcRenderer.on("auth:callback", listener);
    return () => ipcRenderer.removeListener("auth:callback", listener);
  },
  onKeepAwakeState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: KeepAwakeState) => {
      callback(state);
    };
    ipcRenderer.on("keep-awake:state", listener);
    return () => ipcRenderer.removeListener("keep-awake:state", listener);
  },
};

contextBridge.exposeInMainWorld("hitchDaemon", api);
