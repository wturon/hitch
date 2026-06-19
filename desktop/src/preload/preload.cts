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

// Local-only loop state (never synced): per-loop enabled flag + trusted
// trigger-script hashes. Keyed by loopPath ("loops/<slug>"); `trusted` maps a
// script path (rel to .hitch/) to its trusted SHA-256.
export interface LoopLocalState {
  enabled: boolean;
  trusted: Record<string, string>;
}
export type ProjectLoopStates = Record<string, LoopLocalState>;

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
  getLoopStates: (projectId: ProjectId) => Promise<ProjectLoopStates>;
  setLoopEnabled: (
    projectId: ProjectId,
    loopPath: string,
    enabled: boolean,
  ) => Promise<ProjectLoopStates>;
  setLoopTrust: (
    projectId: ProjectId,
    loopPath: string,
    scriptPath: string,
    sha256: string,
  ) => Promise<ProjectLoopStates>;
  clearLoopTrust: (
    projectId: ProjectId,
    loopPath: string,
    scriptPath: string,
  ) => Promise<ProjectLoopStates>;
  enableCmuxAutomation: () => Promise<EnableCmuxResult>;
  openCmuxApp: () => Promise<string>;
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
  getLoopStates: (projectId) => ipcRenderer.invoke("loops:get-state", projectId),
  setLoopEnabled: (projectId, loopPath, enabled) =>
    ipcRenderer.invoke("loops:set-enabled", projectId, loopPath, enabled),
  setLoopTrust: (projectId, loopPath, scriptPath, sha256) =>
    ipcRenderer.invoke("loops:set-trust", projectId, loopPath, scriptPath, sha256),
  clearLoopTrust: (projectId, loopPath, scriptPath) =>
    ipcRenderer.invoke("loops:clear-trust", projectId, loopPath, scriptPath),
  enableCmuxAutomation: () => ipcRenderer.invoke("cmux:enable-automation"),
  openCmuxApp: () => ipcRenderer.invoke("cmux:open-app"),
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
