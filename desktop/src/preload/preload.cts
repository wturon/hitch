import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";

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
  getStartingPrompts: () => Promise<StartingPrompt[]>;
  setStartingPrompts: (prompts: StartingPrompt[]) => Promise<StartingPrompt[]>;
  enableCmuxAutomation: () => Promise<EnableCmuxResult>;
  openCmuxApp: () => Promise<string>;
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
  getStartingPrompts: () => ipcRenderer.invoke("config:get-starting-prompts"),
  setStartingPrompts: (prompts) =>
    ipcRenderer.invoke("config:set-starting-prompts", prompts),
  enableCmuxAutomation: () => ipcRenderer.invoke("cmux:enable-automation"),
  openCmuxApp: () => ipcRenderer.invoke("cmux:open-app"),
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
