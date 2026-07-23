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
  getTextGenerationModel: () => Promise<string>;
  setTextGenerationModel: (model: string) => Promise<string>;
  getExperimentalFlags: () => Promise<Record<string, boolean>>;
  setExperimentalFlag: (
    key: string,
    enabled: boolean,
  ) => Promise<Record<string, boolean>>;
  getStartingPrompts: () => Promise<StartingPrompt[]>;
  setStartingPrompts: (prompts: StartingPrompt[]) => Promise<StartingPrompt[]>;
  enableCmuxAutomation: () => Promise<EnableCmuxResult>;
  openCmuxApp: () => Promise<string>;
  chooseLocalPath: (defaultPath?: string) => Promise<string | null>;
  getUpdaterStatus: () => Promise<UpdaterStatus>;
  checkForUpdates: () => Promise<UpdaterStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getKeepAwakeState: () => Promise<KeepAwakeState>;
  startKeepAwake: () => Promise<KeepAwakeState>;
  stopKeepAwake: () => Promise<KeepAwakeState>;
  setNativeTheme: (mode: "light" | "dark" | "system") => Promise<void>;
  copyImageFromUrl: (url: string) => Promise<void>;
  // Spellcheck: apply a fix the renderer's custom menu chose, and subscribe to the
  // main process pushing suggestions on a right-click over a misspelled word.
  replaceMisspelling: (word: string) => Promise<void>;
  addWordToDictionary: (word: string) => Promise<void>;
  onSpellcheckMenu: (
    callback: (payload: SpellcheckMenuPayload) => void,
  ) => () => void;
  onState: (callback: (state: DaemonState) => void) => () => void;
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => () => void;
  onKeepAwakeState: (callback: (state: KeepAwakeState) => void) => () => void;
}

interface SpellcheckMenuPayload {
  word: string;
  suggestions: string[];
  x: number;
  y: number;
}

// --- V2 server bridge (window.hitchServer) ---
// Present in every build; getConfig() returns null unless the main process was
// launched with HITCH_SERVER_URL, which is what flips the renderer into V2.
export interface HitchServerConfig {
  serverUrl: string;
}

export type HitchServerAuthResult = { ok: true } | { ok: false; error: string };

export interface HitchServerApi {
  getConfig: () => Promise<HitchServerConfig | null>;
  getApiKey: () => Promise<string | null>;
  signIn: (input: { email: string; password: string }) => Promise<HitchServerAuthResult>;
  signUp: (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<HitchServerAuthResult>;
  signOut: () => Promise<void>;
  // Send an ephemeral client event (e.g. focus) up the main-held socket — the
  // renderer can't hold the api-key'd WS itself. Resolves true if it went out.
  wsSend: (message: unknown) => Promise<boolean>;
  // Parsed server WS frames, forwarded verbatim by the main-held socket. The
  // renderer narrows them against @hitch/shared's WsServerMessage.
  onWsMessage: (callback: (message: unknown) => void) => () => void;
  onWsOpen: (callback: () => void) => () => void;
  // Connectivity for the unreachable banner: current state on demand plus a
  // push on every transition (true = socket open, false = closed/refused).
  getWsStatus: () => Promise<boolean>;
  onWsStatus: (callback: (connected: boolean) => void) => () => void;
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
  getTextGenerationModel: () =>
    ipcRenderer.invoke("config:get-text-generation-model"),
  setTextGenerationModel: (model) =>
    ipcRenderer.invoke("config:set-text-generation-model", model),
  getExperimentalFlags: () => ipcRenderer.invoke("config:get-experimental"),
  setExperimentalFlag: (key, enabled) =>
    ipcRenderer.invoke("config:set-experimental", key, enabled),
  getStartingPrompts: () => ipcRenderer.invoke("config:get-starting-prompts"),
  setStartingPrompts: (prompts) =>
    ipcRenderer.invoke("config:set-starting-prompts", prompts),
  enableCmuxAutomation: () => ipcRenderer.invoke("cmux:enable-automation"),
  openCmuxApp: () => ipcRenderer.invoke("cmux:open-app"),
  chooseLocalPath: (defaultPath) => ipcRenderer.invoke("dialog:choose-local-path", defaultPath),
  getUpdaterStatus: () => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  getKeepAwakeState: () => ipcRenderer.invoke("keep-awake:get-state"),
  startKeepAwake: () => ipcRenderer.invoke("keep-awake:start"),
  stopKeepAwake: () => ipcRenderer.invoke("keep-awake:stop"),
  setNativeTheme: (mode) => ipcRenderer.invoke("theme:set-source", mode),
  copyImageFromUrl: (url) => ipcRenderer.invoke("clipboard:copy-image-from-url", url),
  replaceMisspelling: (word) => ipcRenderer.invoke("spellcheck:replace", word),
  addWordToDictionary: (word) =>
    ipcRenderer.invoke("spellcheck:add-to-dictionary", word),
  onSpellcheckMenu: (callback) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: SpellcheckMenuPayload,
    ) => {
      callback(payload);
    };
    ipcRenderer.on("spellcheck:show", listener);
    return () => ipcRenderer.removeListener("spellcheck:show", listener);
  },
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
  onKeepAwakeState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: KeepAwakeState) => {
      callback(state);
    };
    ipcRenderer.on("keep-awake:state", listener);
    return () => ipcRenderer.removeListener("keep-awake:state", listener);
  },
};

contextBridge.exposeInMainWorld("hitchDaemon", api);

const serverApi: HitchServerApi = {
  getConfig: () => ipcRenderer.invoke("hitch-server:get-config"),
  getApiKey: () => ipcRenderer.invoke("hitch-server:get-api-key"),
  signIn: (input) => ipcRenderer.invoke("hitch-server:sign-in", input),
  signUp: (input) => ipcRenderer.invoke("hitch-server:sign-up", input),
  signOut: () => ipcRenderer.invoke("hitch-server:sign-out"),
  wsSend: (message) => ipcRenderer.invoke("hitch-server:ws-send", message),
  onWsMessage: (callback) => {
    const listener = (_event: IpcRendererEvent, message: unknown) => {
      callback(message);
    };
    ipcRenderer.on("hitch-server:ws-message", listener);
    return () => ipcRenderer.removeListener("hitch-server:ws-message", listener);
  },
  onWsOpen: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("hitch-server:ws-open", listener);
    return () => ipcRenderer.removeListener("hitch-server:ws-open", listener);
  },
  getWsStatus: () => ipcRenderer.invoke("hitch-server:get-ws-status"),
  onWsStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, connected: boolean) => {
      callback(connected);
    };
    ipcRenderer.on("hitch-server:ws-status", listener);
    return () => ipcRenderer.removeListener("hitch-server:ws-status", listener);
  },
};

contextBridge.exposeInMainWorld("hitchServer", serverApi);
