import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";

type DaemonStatus = "running" | "stopped" | "starting" | "stopping";

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
  project: string;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

export interface LocalHitchConfig {
  activeProject: string;
  hitches: HitchBinding[];
}

export interface AddHitchInput {
  project: string;
  projectName?: string;
  localPath: string;
  updateGitignore?: boolean;
}

export interface AddHitchResult {
  config: LocalHitchConfig;
  gitignoreUpdated: boolean;
  restarted: boolean;
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
  setActiveProject: (project: string) => Promise<LocalHitchConfig>;
  addHitch: (input: AddHitchInput) => Promise<AddHitchResult>;
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
  setActiveProject: (project) => ipcRenderer.invoke("config:set-active-project", project),
  addHitch: (input) => ipcRenderer.invoke("config:add-hitch", input),
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
