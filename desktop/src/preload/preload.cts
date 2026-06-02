import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";

type DaemonStatus = "running" | "stopped" | "starting" | "stopping";
type ProjectId = string;

export interface LogEntry {
  id: number;
  at: string;
  stream: "system" | "stdout" | "stderr";
  message: string;
}

export interface DaemonState {
  status: DaemonStatus;
  pid: number | null;
  repoRoot: string;
  configPath: string;
  logs: LogEntry[];
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
  scriptExists: boolean;
  configWired: boolean;
}

export interface HarnessSetupStatus {
  projectId: ProjectId;
  hitch: HitchBinding | null;
  localPathExists: boolean;
  codex: HarnessHookStatus;
  claudeCode: HarnessHookStatus;
}

export interface DeviceAuthState {
  deviceId: string;
  deviceName: string;
  hostname: string;
  hasToken: boolean;
}

export interface HitchDaemonApi {
  getState: () => Promise<DaemonState>;
  start: () => Promise<DaemonState>;
  stop: () => Promise<DaemonState>;
  clearLogs: () => Promise<DaemonState>;
  getConfig: () => Promise<LocalHitchConfig>;
  addHitch: (input: AddHitchInput) => Promise<AddHitchResult>;
  getProjectSetup: (projectId: ProjectId) => Promise<ProjectSetupStatus>;
  ensureHitchDirectory: (projectId: ProjectId) => Promise<ProjectSetupStatus>;
  ensureGitignore: (projectId: ProjectId) => Promise<ProjectSetupStatus>;
  getHarnessSetup: (projectId: ProjectId) => Promise<HarnessSetupStatus>;
  installHarnessHooks: (
    projectId: ProjectId,
    harness: Harness,
  ) => Promise<HarnessSetupStatus>;
  openCodexHookTrust: (projectId: ProjectId) => Promise<string>;
  chooseLocalPath: (defaultPath?: string) => Promise<string | null>;
  getDeviceAuth: () => Promise<DeviceAuthState>;
  setDeviceToken: (token: string) => Promise<DeviceAuthState>;
  clearDeviceToken: () => Promise<DeviceAuthState>;
  onState: (callback: (state: DaemonState) => void) => () => void;
}

const api: HitchDaemonApi = {
  getState: () => ipcRenderer.invoke("daemon:get-state"),
  start: () => ipcRenderer.invoke("daemon:start"),
  stop: () => ipcRenderer.invoke("daemon:stop"),
  clearLogs: () => ipcRenderer.invoke("daemon:clear-logs"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  addHitch: (input) => ipcRenderer.invoke("config:add-hitch", input),
  getProjectSetup: (projectId) => ipcRenderer.invoke("config:get-project-setup", projectId),
  ensureHitchDirectory: (projectId) => ipcRenderer.invoke("config:ensure-hitch-directory", projectId),
  ensureGitignore: (projectId) => ipcRenderer.invoke("config:ensure-gitignore", projectId),
  getHarnessSetup: (projectId) => ipcRenderer.invoke("config:get-harness-setup", projectId),
  installHarnessHooks: (projectId, harness) =>
    ipcRenderer.invoke("config:install-harness-hooks", projectId, harness),
  openCodexHookTrust: (projectId) =>
    ipcRenderer.invoke("config:open-codex-hook-trust", projectId),
  chooseLocalPath: (defaultPath) => ipcRenderer.invoke("dialog:choose-local-path", defaultPath),
  getDeviceAuth: () => ipcRenderer.invoke("device-auth:get"),
  setDeviceToken: (token) => ipcRenderer.invoke("device-auth:set-token", token),
  clearDeviceToken: () => ipcRenderer.invoke("device-auth:clear-token"),
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: DaemonState) => {
      callback(state);
    };
    ipcRenderer.on("daemon:state", listener);
    return () => ipcRenderer.removeListener("daemon:state", listener);
  },
};

contextBridge.exposeInMainWorld("hitchDaemon", api);
