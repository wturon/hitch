import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

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

interface RunnerMessage {
  type?: unknown;
  stream?: unknown;
  message?: unknown;
  project?: unknown;
  localPath?: unknown;
  hitchPath?: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const repoRoot = process.env.HITCH_ROOT
  ? resolve(process.env.HITCH_ROOT)
  : resolve(app.getAppPath(), "..");
const localConfigPath =
  process.env.HITCH_CONFIG_PATH ?? join(homedir(), "Library/Application Support/Hitch/config.json");
const devRendererUrl =
  process.env.HITCH_DESKTOP_RENDERER_URL ?? "http://127.0.0.1:5173";

let mainWindow: BrowserWindow | null = null;
let daemon: ChildProcess | null = null;
let status: DaemonStatus = "stopped";
let nextLogId = 1;
const logs: LogEntry[] = [];
const maxLogs = 500;
let stopTimer: NodeJS.Timeout | null = null;
let quitAfterDaemonStops = false;

function state(): DaemonState {
  return {
    status,
    pid: daemon?.pid ?? null,
    repoRoot,
    configPath: localConfigPath,
    logs,
  };
}

function broadcastState(): void {
  mainWindow?.webContents.send("daemon:state", state());
}

function addLog(stream: LogEntry["stream"], message: string): void {
  for (const line of message.split(/\r?\n/)) {
    if (!line.trim()) continue;
    logs.push({
      id: nextLogId++,
      at: new Date().toLocaleTimeString(),
      stream,
      message: line,
    });
  }
  if (logs.length > maxLogs) logs.splice(0, logs.length - maxLogs);
  broadcastState();
}

function setStatus(next: DaemonStatus): void {
  status = next;
  broadcastState();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function daemonRunnerCommand(): { command: string; args: string[] } {
  const nodeBin =
    process.env.HITCH_NODE_BIN ?? process.env.npm_node_execpath ?? "node";

  if (isDev) {
    return {
      command: nodeBin,
      args: [
        join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "daemon/src/runner.ts"),
      ],
    };
  }

  return {
    command: nodeBin,
    args: [join(process.resourcesPath, "daemon/runner.js")],
  };
}

function migrateRepoConfigToLocalConfig(raw: unknown): unknown {
  if (!isRecord(raw)) throw new Error("expected repo config to be an object");

  if (Array.isArray(raw.hitches)) {
    return {
      activeProject:
        typeof raw.activeProject === "string"
          ? raw.activeProject
          : typeof raw.activeWorkspace === "string"
            ? raw.activeWorkspace
            : undefined,
      hitches: raw.hitches.map((entry) => {
        if (!isRecord(entry)) return entry;
        const localPath =
          typeof entry.localPath === "string"
            ? resolve(repoRoot, entry.localPath)
            : typeof entry.repoPath === "string"
              ? resolve(repoRoot, entry.repoPath)
              : typeof entry.hitchPath === "string"
                ? resolve(resolve(repoRoot, entry.hitchPath), "..")
                : repoRoot;
        return {
          project:
            typeof entry.project === "string"
              ? entry.project
              : typeof entry.workspace === "string"
                ? entry.workspace
                : undefined,
          projectName:
            typeof entry.projectName === "string" ? entry.projectName : undefined,
          localPath,
          enabled: entry.enabled,
        };
      }),
    };
  }

  if (typeof raw.workspace === "string" && Array.isArray(raw.watch)) {
    return {
      activeProject: raw.workspace,
      hitches: raw.watch.map((entry) => {
        if (!isRecord(entry)) return entry;
        const rawPath = typeof entry.path === "string" ? entry.path : ".hitch";
        const hitchPath = resolve(repoRoot, rawPath);
        return {
          project: raw.workspace,
          localPath: resolve(hitchPath, ".."),
          enabled: true,
        };
      }),
    };
  }

  throw new Error("expected hitches or legacy watch array");
}

function ensureLocalConfig(): void {
  const repoConfigPath = join(repoRoot, "hitch.config.json");
  const wasExisting = existsSync(localConfigPath);
  const sourcePath = wasExisting ? localConfigPath : repoConfigPath;
  if (!existsSync(sourcePath)) {
    throw new Error(
      `No local Hitch config found at ${localConfigPath}, and no dev fallback found at ${repoConfigPath}`,
    );
  }

  const existingText = readFileSync(sourcePath, "utf8");
  const parsed = JSON.parse(existingText) as unknown;
  const localConfig = normalizeLocalConfig(
    wasExisting ? parsed : migrateRepoConfigToLocalConfig(parsed),
  );
  const nextText = `${JSON.stringify(localConfig, null, 2)}\n`;
  if (wasExisting && existingText === nextText) return;

  mkdirSync(dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, nextText, "utf8");
  addLog(
    "system",
    wasExisting
      ? `Migrated local Hitch config at ${localConfigPath}`
      : `Created local Hitch config at ${localConfigPath}`,
  );
}

function normalizeLocalConfig(raw: unknown): LocalHitchConfig {
  if (!isRecord(raw)) throw new Error("expected Hitch config object");
  if (!Array.isArray(raw.hitches)) throw new Error("hitches must be an array");

  const hitches = raw.hitches.map((entry, index): HitchBinding => {
    if (!isRecord(entry)) throw new Error(`hitches[${index}] must be an object`);
    const project =
      typeof entry.project === "string"
        ? entry.project.trim()
        : typeof entry.workspace === "string"
          ? entry.workspace.trim()
          : "";
    const projectName =
      typeof entry.projectName === "string" && entry.projectName.trim()
        ? entry.projectName.trim()
        : undefined;
    const localPath =
      typeof entry.localPath === "string"
        ? resolve(entry.localPath)
        : typeof entry.repoPath === "string"
          ? resolve(entry.repoPath)
          : typeof entry.hitchPath === "string"
            ? resolve(resolve(entry.hitchPath), "..")
            : "";
    const enabled = entry.enabled !== false;

    if (!project) throw new Error(`hitches[${index}].project is required`);
    if (!localPath) throw new Error(`hitches[${index}].localPath is required`);

    return { project, projectName, localPath, enabled };
  });

  const activeProject =
    typeof raw.activeProject === "string" && raw.activeProject.trim()
      ? raw.activeProject.trim()
      : typeof raw.activeWorkspace === "string" && raw.activeWorkspace.trim()
        ? raw.activeWorkspace.trim()
        : hitches[0]?.project ?? "";

  return { activeProject, hitches };
}

function readLocalConfig(): LocalHitchConfig {
  ensureLocalConfig();
  return normalizeLocalConfig(
    JSON.parse(readFileSync(localConfigPath, "utf8")) as unknown,
  );
}

function writeLocalConfig(config: LocalHitchConfig): LocalHitchConfig {
  mkdirSync(dirname(localConfigPath), { recursive: true });
  writeFileSync(
    localConfigPath,
    `${JSON.stringify(normalizeLocalConfig(config), null, 2)}\n`,
    "utf8",
  );
  return readLocalConfig();
}

function updateGitignore(localPath: string): boolean {
  const gitignorePath = join(localPath, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  if (
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === ".hitch/" || line === ".hitch")
  ) {
    return false;
  }

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignorePath, `${prefix}.hitch/\n`, "utf8");
  return true;
}

async function restartDaemon(): Promise<boolean> {
  if (!daemon) {
    startDaemon();
    return true;
  }

  return new Promise((resolveRestart) => {
    const child = daemon;
    if (!child) {
      startDaemon();
      resolveRestart(true);
      return;
    }

    child.once("exit", () => {
      startDaemon();
      resolveRestart(true);
    });
    stopDaemon();
  });
}

async function addHitch(input: AddHitchInput): Promise<AddHitchResult> {
  const project = input.project.trim();
  const projectName = input.projectName?.trim() || undefined;
  const localPath = resolve(input.localPath.trim());
  if (!project) throw new Error("Project is required");
  if (!localPath) throw new Error("Local path is required");
  if (!existsSync(localPath)) throw new Error(`Local path does not exist: ${localPath}`);

  const hitchPath = join(localPath, ".hitch");
  mkdirSync(hitchPath, { recursive: true });

  const config = readLocalConfig();
  config.activeProject = project;
  const next: HitchBinding = {
    project,
    projectName,
    localPath,
    enabled: true,
  };

  const existingIndex = config.hitches.findIndex(
    (hitch) => hitch.project === project,
  );
  if (existingIndex >= 0) {
    config.hitches[existingIndex] = next;
  } else {
    config.hitches.push(next);
  }

  const savedConfig = writeLocalConfig(config);
  const gitignoreUpdated = input.updateGitignore === false ? false : updateGitignore(localPath);
  addLog("system", `Hitched project ${project} to ${localPath}`);
  const restarted = await restartDaemon();
  return { config: savedConfig, gitignoreUpdated, restarted };
}

function handleRunnerMessage(message: RunnerMessage): void {
  if (!isRecord(message)) return;

  if (message.type === "ready") {
    const project =
      typeof message.project === "string" ? message.project : "unknown";
    const localPath =
      typeof message.localPath === "string" ? message.localPath : "unknown local path";
    const hitchPath =
      typeof message.hitchPath === "string" ? message.hitchPath : join(localPath, ".hitch");
    addLog(
      "system",
      `Daemon runtime ready for project ${project} at ${hitchPath}`,
    );
    setStatus("running");
    return;
  }

  if (message.type === "log") {
    const stream = message.stream === "stderr" ? "stderr" : "stdout";
    addLog(stream, String(message.message ?? ""));
    return;
  }

  if (message.type === "error") {
    addLog("stderr", String(message.message ?? "Daemon runner error"));
    return;
  }

  if (message.type === "stopped") {
    addLog("system", "Daemon runtime stopped");
  }
}

function startDaemon(): DaemonState {
  if (daemon) return state();

  setStatus("starting");
  try {
    ensureLocalConfig();
  } catch (err) {
    addLog("stderr", `Failed to prepare local config: ${String(err)}`);
    setStatus("stopped");
    return state();
  }

  const { command, args } = daemonRunnerCommand();
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HITCH_ROOT: repoRoot,
      HITCH_CONFIG_PATH: localConfigPath,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  daemon = child;

  addLog("system", `Starting daemon runner in ${repoRoot}`);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => addLog("stdout", String(chunk)));
  child.stderr?.on("data", (chunk) => addLog("stderr", String(chunk)));
  child.on("message", (message) => handleRunnerMessage(message as RunnerMessage));
  child.once("spawn", () => {
    addLog("system", `Daemon runner started with pid ${daemon?.pid ?? "unknown"}`);
  });
  child.once("error", (error) => {
    addLog("stderr", `Failed to start daemon: ${error.message}`);
    daemon = null;
    setStatus("stopped");
  });
  child.once("exit", (code, signal) => {
    addLog(
      "system",
      `Daemon exited${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
    );
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    daemon = null;
    setStatus("stopped");
    if (quitAfterDaemonStops) app.quit();
  });

  return state();
}

function stopDaemon(): DaemonState {
  if (!daemon) return state();
  setStatus("stopping");
  addLog("system", "Stopping daemon");
  if (daemon.connected) daemon.send({ type: "stop" });
  stopTimer = setTimeout(() => {
    if (daemon) {
      addLog("system", "Daemon did not stop after 5s; sending SIGTERM");
      daemon.kill("SIGTERM");
    }
  }, 5_000);
  return state();
}

function clearLogs(): DaemonState {
  logs.splice(0, logs.length);
  broadcastState();
  return state();
}

function redirectLegacyDevAuthUrl(rawUrl: string): string | null {
  if (!isDev) return null;

  try {
    const url = new URL(rawUrl);
    if (
      (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
      url.port !== "3000"
    ) {
      return null;
    }

    const target = new URL(devRendererUrl);
    target.pathname = url.pathname;
    target.search = url.search;
    target.hash = url.hash;
    return target.toString();
  } catch {
    return null;
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    title: "Hitch",
    backgroundColor: "#101316",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const redirect = redirectLegacyDevAuthUrl(url);
    if (!redirect) return;
    event.preventDefault();
    void mainWindow?.loadURL(redirect);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const redirect = redirectLegacyDevAuthUrl(url);
    if (!redirect) return { action: "allow" };
    void mainWindow?.loadURL(redirect);
    return { action: "deny" };
  });

  if (isDev) {
    await mainWindow.loadURL(devRendererUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("daemon:get-state", () => state());
ipcMain.handle("daemon:start", () => startDaemon());
ipcMain.handle("daemon:stop", () => stopDaemon());
ipcMain.handle("daemon:clear-logs", () => clearLogs());
ipcMain.handle("config:get", () => readLocalConfig());
ipcMain.handle("config:add-hitch", (_event, input: AddHitchInput) =>
  addHitch(input),
);

app.whenReady().then(async () => {
  await createWindow();
  startDaemon();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", (event) => {
  if (!daemon || quitAfterDaemonStops) return;
  event.preventDefault();
  quitAfterDaemonStops = true;
  stopDaemon();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
