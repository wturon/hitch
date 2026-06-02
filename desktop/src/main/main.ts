import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";

type DaemonStatus = "running" | "stopped" | "starting" | "stopping";
type ProjectId = string;

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
  projectId: ProjectId;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

interface LocalHitchConfig {
  hitches: HitchBinding[];
}

interface AddHitchInput {
  projectId: ProjectId;
  projectName?: string;
  localPath: string;
  updateGitignore?: boolean;
}

interface AddHitchResult {
  config: LocalHitchConfig;
  gitignoreUpdated: boolean;
  restarted: boolean;
}

interface ProjectSetupStatus {
  projectId: ProjectId;
  hitch: HitchBinding | null;
  localPathExists: boolean;
  hitchPath: string | null;
  hitchPathExists: boolean;
  gitignorePath: string | null;
  gitignoreExists: boolean;
  gitignoreHasHitch: boolean;
}

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

interface DeviceAuthState {
  deviceId: string;
  deviceName: string;
  hostname: string;
  hasToken: boolean;
}

interface LocalSecrets {
  deviceId?: string;
  deviceToken?: string;
}

interface RunnerMessage {
  type?: unknown;
  stream?: unknown;
  message?: unknown;
  projectId?: unknown;
  localPath?: unknown;
  hitchPath?: unknown;
  hitches?: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
// In dev the app lives inside the repo, so the parent of the app path is the
// repo root (used for the dev config fallback and as the daemon cwd). A packaged
// app has no repo, so anchor on the writable userData dir instead — local config
// paths are absolute, so the daemon's cwd is not load-bearing in production.
const repoRoot = process.env.HITCH_ROOT
  ? resolve(process.env.HITCH_ROOT)
  : isDev
    ? resolve(app.getAppPath(), "..")
    : app.getPath("userData");
const localConfigPath =
  process.env.HITCH_CONFIG_PATH ?? join(homedir(), "Library/Application Support/Hitch/config.json");
const localSecretsPath =
  process.env.HITCH_SECRETS_PATH ?? join(homedir(), "Library/Application Support/Hitch/secrets.json");
const devRendererUrl =
  process.env.HITCH_DESKTOP_RENDERER_URL ?? "http://127.0.0.1:5173";
const run = promisify(execFile);

function globalCodexChatStatusHook(): string {
  return `#!/usr/bin/env node
// Hitch user-level Codex lifecycle hook. This hook is installed globally, so it
// must scope itself: it only touches task files inside enabled Hitch roots.
//
// Contract: never break Codex. Parse stdin, do a best-effort frontmatter edit,
// and exit 0 without output for unrelated sessions or failures.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const HITCH_CONFIG_PATH = ${JSON.stringify(localConfigPath)};

const STATUS_FOR_EVENT = {
  UserPromptSubmit: "working",
  userPromptSubmit: "working",
  Stop: "waiting",
  stop: "waiting",
};

const TERMINAL_TASK_STATUSES = new Set(["archived", "done"]);

const FRONTMATTER_RE = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/;

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const fm = {};
  for (const line of match[1].split(/\\r?\\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    fm[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^[\\"']|[\\"']$/g, "");
  }
  return fm;
}

function setKey(content, key, value) {
  const eol = content.includes("\\r\\n") ? "\\r\\n" : "\\n";
  const match = content.match(FRONTMATTER_RE);
  let lines = match ? match[1].split(/\\r?\\n/) : [];
  const body = match ? match[2] : content;
  lines = lines.filter((line) => {
    const idx = line.indexOf(":");
    return idx === -1 || line.slice(0, idx).trim() !== key;
  });
  if (value != null && value !== "") lines.push(\`\${key}: \${value}\`);
  return \`---\${eol}\${lines.join(eol)}\${eol}---\${eol}\${body}\`;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function candidateChatIds(payload) {
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
    payload.thread?.id,
    process.env.CODEX_THREAD_ID,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  const transcriptPath =
    typeof payload.transcript_path === "string"
      ? payload.transcript_path
      : typeof payload.transcriptPath === "string"
        ? payload.transcriptPath
        : "";
  const transcriptId = transcriptPath.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (transcriptId) candidates.push(transcriptId[0]);

  return new Set(candidates);
}

function taskStatus(fm) {
  return (fm.status ?? "").trim().toLowerCase().replace(/\\s+/g, "-");
}

function isInside(root, cwd) {
  const rel = relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function hitchRoots() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(HITCH_CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
  if (!raw || !Array.isArray(raw.hitches)) return [];

  return raw.hitches
    .filter((entry) => entry && entry.enabled !== false)
    .map((entry) => (typeof entry.localPath === "string" ? entry.localPath.trim() : ""))
    .filter(Boolean)
    .map((localPath) => resolve(localPath));
}

function rootForCwd(cwd) {
  const resolvedCwd = resolve(cwd || process.cwd());
  return hitchRoots().find((root) => isInside(root, resolvedCwd)) ?? null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  const event = payload.hook_event_name || payload.hookEventName;
  if (!(event in STATUS_FOR_EVENT)) return;
  const status = STATUS_FOR_EVENT[event];

  const chatIds = candidateChatIds(payload);
  if (chatIds.size === 0) return;

  const root = rootForCwd(
    payload.cwd ||
      process.env.CODEX_PROJECT_DIR ||
      process.env.PWD ||
      process.cwd(),
  );
  if (!root) return;

  const tasksDir = join(root, ".hitch", "tasks");
  if (!existsSync(tasksDir)) return;

  let slugs;
  try {
    slugs = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of slugs) {
    if (!entry.isDirectory()) continue;
    const file = join(tasksDir, entry.name, "task.md");
    if (!existsSync(file)) continue;

    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm || fm["chat-harness"] !== "codex" || !chatIds.has(fm["chat-id"])) {
      continue;
    }

    const nextStatus =
      status === "waiting" && TERMINAL_TASK_STATUSES.has(taskStatus(fm))
        ? undefined
        : status;
    const current = (fm["chat-status"] ?? "").trim() || null;
    if (current === (nextStatus ?? null)) return;

    try {
      writeFileSync(file, setKey(content, "chat-status", nextStatus));
    } catch {
      // Best effort; never fail the hook.
    }
    return;
  }
}

try {
  main();
} catch {
  // Never let a hook error interrupt the session.
}
`;
}

function globalClaudeChatStatusHook(): string {
  return `#!/usr/bin/env node
// Hitch user-level Claude Code lifecycle hook. This hook is installed globally,
// so it must scope itself: it only touches task files inside enabled Hitch
// roots and only for tasks whose chat-harness is claude-code.
//
// Contract: never break the session. Parse stdin, do a best-effort frontmatter
// edit, and exit 0 without output for unrelated sessions or failures.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const HITCH_CONFIG_PATH = ${JSON.stringify(localConfigPath)};

const STATUS_FOR_EVENT = {
  UserPromptSubmit: "working",
  Stop: "waiting",
  SessionEnd: null,
};

const TERMINAL_TASK_STATUSES = new Set(["archived", "done"]);

const FRONTMATTER_RE = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/;

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\\r?\\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    fm[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^[\\"']|[\\"']$/g, "");
  }
  return fm;
}

function setKey(content, key, value) {
  const eol = content.includes("\\r\\n") ? "\\r\\n" : "\\n";
  const match = content.match(FRONTMATTER_RE);
  let lines = match ? match[1].split(/\\r?\\n/) : [];
  const body = match ? match[2] : content;
  lines = lines.filter((line) => {
    const idx = line.indexOf(":");
    return idx === -1 || line.slice(0, idx).trim() !== key;
  });
  if (value != null && value !== "") lines.push(\`\${key}: \${value}\`);
  return \`---\${eol}\${lines.join(eol)}\${eol}---\${eol}\${body}\`;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function taskStatus(fm) {
  return (fm.status ?? "").trim().toLowerCase().replace(/\\s+/g, "-");
}

function isInside(root, cwd) {
  const rel = relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function hitchRoots() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(HITCH_CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
  if (!raw || !Array.isArray(raw.hitches)) return [];

  return raw.hitches
    .filter((entry) => entry && entry.enabled !== false)
    .map((entry) => (typeof entry.localPath === "string" ? entry.localPath.trim() : ""))
    .filter(Boolean)
    .map((localPath) => resolve(localPath));
}

function rootForCwd(cwd) {
  const resolvedCwd = resolve(cwd || process.cwd());
  return hitchRoots().find((root) => isInside(root, resolvedCwd)) ?? null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  const event = payload.hook_event_name;
  if (!(event in STATUS_FOR_EVENT)) return;
  const status = STATUS_FOR_EVENT[event];

  const sessionId = payload.session_id;
  if (!sessionId) return;

  const root = rootForCwd(
    payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd(),
  );
  if (!root) return;

  const tasksDir = join(root, ".hitch", "tasks");
  if (!existsSync(tasksDir)) return;

  let slugs;
  try {
    slugs = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of slugs) {
    if (!entry.isDirectory()) continue;
    const file = join(tasksDir, entry.name, "task.md");
    if (!existsSync(file)) continue;

    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm || fm["chat-harness"] !== "claude-code" || fm["chat-id"] !== sessionId) {
      continue;
    }

    const nextStatus =
      status === "waiting" && TERMINAL_TASK_STATUSES.has(taskStatus(fm))
        ? undefined
        : status;
    const current = (fm["chat-status"] ?? "").trim() || null;
    if (current === (nextStatus ?? null)) return;

    try {
      writeFileSync(file, setKey(content, "chat-status", nextStatus));
    } catch {
      // Best effort; never fail the hook.
    }
    return;
  }
}

try {
  main();
} catch {
  // Never let a hook error interrupt the session.
}
`;
}

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

  // In a packaged app there is no system `node` to rely on, so run the bundled
  // daemon under Electron's own Node by launching the Electron binary with
  // ELECTRON_RUN_AS_NODE=1 (set in the spawn env in startDaemon). The daemon
  // never imports `electron`, so running it as plain Node is fine.
  return {
    command: process.execPath,
    args: [join(process.resourcesPath, "daemon/runner.js")],
  };
}

// Packaged builds ship an app-config.json (written at build time from the prod
// CONVEX_URL) into the app resources. The Convex deployment URL is not secret —
// the renderer ships it too — so baking it lets the daemon reach the right
// backend without a system .env. In dev this file is absent and the daemon
// derives the URL from .env.local (CONVEX_DEPLOYMENT) as before.
function readBakedConvexUrl(): string | undefined {
  if (isDev) return undefined;
  try {
    const raw = readFileSync(join(process.resourcesPath, "app-config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.convexUrl === "string" &&
      parsed.convexUrl.trim()
    ) {
      return parsed.convexUrl.trim();
    }
  } catch {
    // No baked config — fall back to env-file derivation in the daemon.
  }
  return undefined;
}

function emptyLocalConfig(): LocalHitchConfig {
  return { hitches: [] };
}

function ensureLocalConfig(): void {
  const repoConfigPath = join(repoRoot, "hitch.config.json");
  const wasExisting = existsSync(localConfigPath);
  const sourcePath = wasExisting ? localConfigPath : repoConfigPath;
  if (!existsSync(sourcePath)) {
    // Fresh install: no local config and no dev repo fallback. Bootstrap an
    // empty config so the UI (readLocalConfig / addHitch) works and the user can
    // hitch their first project; the daemon stays idle until a hitch exists.
    const emptyConfig = emptyLocalConfig();
    mkdirSync(dirname(localConfigPath), { recursive: true });
    writeFileSync(
      localConfigPath,
      `${JSON.stringify(emptyConfig, null, 2)}\n`,
      "utf8",
    );
    addLog("system", `Created empty Hitch config at ${localConfigPath}`);
    return;
  }

  const existingText = readFileSync(sourcePath, "utf8");
  let localConfig: LocalHitchConfig;
  try {
    localConfig = normalizeLocalConfig(JSON.parse(existingText) as unknown);
  } catch (err) {
    localConfig = emptyLocalConfig();
    addLog(
      "system",
      `Discarded old Hitch config at ${sourcePath}: ${String(err)}`,
    );
  }
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
    const projectId =
      typeof entry.projectId === "string" ? entry.projectId.trim() : "";
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

    if (!projectId) throw new Error(`hitches[${index}].projectId is required`);
    if (!localPath) throw new Error(`hitches[${index}].localPath is required`);

    return { projectId, projectName, localPath, enabled };
  });

  return { hitches };
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

function readLocalSecrets(): LocalSecrets {
  if (!existsSync(localSecretsPath)) return {};
  const raw = JSON.parse(readFileSync(localSecretsPath, "utf8")) as unknown;
  if (!isRecord(raw)) return {};
  return {
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
    deviceToken: typeof raw.deviceToken === "string" ? raw.deviceToken : undefined,
  };
}

function writeLocalSecrets(secrets: LocalSecrets): LocalSecrets {
  mkdirSync(dirname(localSecretsPath), { recursive: true });
  writeFileSync(localSecretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
  return readLocalSecrets();
}

function ensureDeviceId(): string {
  const secrets = readLocalSecrets();
  if (secrets.deviceId) return secrets.deviceId;
  const deviceId = randomUUID();
  writeLocalSecrets({ ...secrets, deviceId });
  return deviceId;
}

function readDeviceToken(): string | undefined {
  return readLocalSecrets().deviceToken?.trim() || process.env.HITCH_DEVICE_TOKEN?.trim();
}

function deviceAuthState(): DeviceAuthState {
  return {
    deviceId: ensureDeviceId(),
    deviceName: hostname(),
    hostname: hostname(),
    hasToken: Boolean(readDeviceToken()),
  };
}

async function saveDeviceToken(token: string): Promise<DeviceAuthState> {
  const next = { ...readLocalSecrets(), deviceId: ensureDeviceId(), deviceToken: token };
  writeLocalSecrets(next);
  addLog("system", "Saved local device authorization");
  await restartDaemon();
  return deviceAuthState();
}

async function clearDeviceToken(): Promise<DeviceAuthState> {
  const secrets = readLocalSecrets();
  writeLocalSecrets({ deviceId: secrets.deviceId ?? ensureDeviceId() });
  addLog("system", "Cleared local device authorization");
  await restartDaemon();
  return deviceAuthState();
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

function gitignoreHasHitch(localPath: string): boolean {
  const gitignorePath = join(localPath, ".gitignore");
  if (!existsSync(gitignorePath)) return false;
  return readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".hitch/" || line === ".hitch");
}

function projectSetupStatus(projectId: ProjectId): ProjectSetupStatus {
  const trimmed = projectId.trim();
  if (!trimmed) throw new Error("Project ID is required");
  const config = readLocalConfig();
  const hitch = config.hitches.find((entry) => entry.projectId === trimmed) ?? null;
  if (!hitch) {
    return {
      projectId: trimmed,
      hitch: null,
      localPathExists: false,
      hitchPath: null,
      hitchPathExists: false,
      gitignorePath: null,
      gitignoreExists: false,
      gitignoreHasHitch: false,
    };
  }

  const localPathExists = existsSync(hitch.localPath);
  const hitchPath = join(hitch.localPath, ".hitch");
  const gitignorePath = join(hitch.localPath, ".gitignore");
  return {
    projectId: trimmed,
    hitch,
    localPathExists,
    hitchPath,
    hitchPathExists: localPathExists && existsSync(hitchPath),
    gitignorePath,
    gitignoreExists: localPathExists && existsSync(gitignorePath),
    gitignoreHasHitch: localPathExists && gitignoreHasHitch(hitch.localPath),
  };
}

function ensureProjectHitchDirectory(projectId: ProjectId): ProjectSetupStatus {
  const setup = projectSetupStatus(projectId);
  if (!setup.hitch) throw new Error("Project is not hitched to a local folder");
  if (!setup.localPathExists) {
    throw new Error(`Local path does not exist: ${setup.hitch.localPath}`);
  }
  mkdirSync(join(setup.hitch.localPath, ".hitch"), { recursive: true });
  addLog("system", `Ensured .hitch folder for ${projectId}`);
  return projectSetupStatus(projectId);
}

function ensureProjectGitignore(projectId: ProjectId): ProjectSetupStatus {
  const setup = projectSetupStatus(projectId);
  if (!setup.hitch) throw new Error("Project is not hitched to a local folder");
  if (!setup.localPathExists) {
    throw new Error(`Local path does not exist: ${setup.hitch.localPath}`);
  }
  updateGitignore(setup.hitch.localPath);
  addLog("system", `Ensured .hitch/ is ignored for ${projectId}`);
  return projectSetupStatus(projectId);
}

function hookEvents(harness: Harness): string[] {
  return harness === "codex"
    ? ["UserPromptSubmit", "Stop"]
    : ["UserPromptSubmit", "Stop", "SessionEnd"];
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function hookCommandExists(
  config: Record<string, unknown>,
  event: string,
  command: string,
): boolean {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
  return blocks.some((block) => {
    if (!isRecord(block) || !Array.isArray(block.hooks)) return false;
    return block.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.type === "command" &&
        hook.command === command,
    );
  });
}

function ensureHookCommand(
  config: Record<string, unknown>,
  event: string,
  command: string,
): void {
  if (!isRecord(config.hooks)) config.hooks = {};
  const hooks = config.hooks;
  if (!isRecord(hooks)) throw new Error("hooks must be a JSON object");
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const blocks = hooks[event];
  if (!Array.isArray(blocks)) throw new Error(`hooks.${event} must be an array`);
  if (hookCommandExists(config, event, command)) return;
  blocks.push({
    hooks: [{ type: "command", command }],
  });
}

const CODEX_CANDIDATES = [
  process.env.CODEX_BIN,
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "codex",
].filter((value): value is string => Boolean(value));

function codexBin(): string {
  for (const candidate of CODEX_CANDIDATES) {
    if (candidate === "codex" || existsSync(candidate)) return candidate;
  }
  return "codex";
}

function shellQuote(value: string): string {
  if (!/[^A-Za-z0-9_./:-]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function codexHomePath(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function globalCodexHooksJsonPath(): string {
  return join(codexHomePath(), "hooks.json");
}

function globalCodexConfigTomlPath(): string {
  return join(codexHomePath(), "config.toml");
}

function globalCodexHookScriptPath(): string {
  return join(dirname(localConfigPath), "hooks", "codex-chat-status.mjs");
}

function globalCodexHookCommand(): string {
  return `node ${shellQuote(globalCodexHookScriptPath())}`;
}

const HITCH_CODEX_TOML_START = "# Hitch Codex chat status hooks: begin";
const HITCH_CODEX_TOML_END = "# Hitch Codex chat status hooks: end";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexConfigHasInlineHooks(): boolean {
  const path = globalCodexConfigTomlPath();
  if (!existsSync(path)) return false;
  return /^\s*\[\[?hooks[.\]]/m.test(readFileSync(path, "utf8"));
}

function removeHitchCodexTomlBlock(content: string): string {
  const start = content.indexOf(HITCH_CODEX_TOML_START);
  if (start === -1) return content;
  const end = content.indexOf(HITCH_CODEX_TOML_END, start);
  if (end === -1) return content;
  const afterEnd = end + HITCH_CODEX_TOML_END.length;
  const before = content.slice(0, start).replace(/\n{2,}$/u, "\n");
  const after = content.slice(afterEnd).replace(/^\n{1,2}/u, "");
  return `${before}${after}`.replace(/\n?$/u, "\n");
}

function hitchCodexTomlBlock(command: string): string {
  const quotedCommand = tomlString(command);
  return [
    HITCH_CODEX_TOML_START,
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${quotedCommand}`,
    "timeout = 30",
    'statusMessage = "Updating Hitch chat status"',
    "",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${quotedCommand}`,
    "timeout = 30",
    'statusMessage = "Updating Hitch chat status"',
    HITCH_CODEX_TOML_END,
    "",
  ].join("\n");
}

function ensureCodexTomlHook(command: string): void {
  const path = globalCodexConfigTomlPath();
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const withoutHitchBlock = removeHitchCodexTomlBlock(current).trimEnd();
  const next = [withoutHitchBlock, hitchCodexTomlBlock(command)]
    .filter(Boolean)
    .join("\n\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${next.trimEnd()}\n`, "utf8");
}

function removeHookCommand(
  config: Record<string, unknown>,
  event: string,
  command: string,
): boolean {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
  let changed = false;
  const nextBlocks = blocks
    .map((block) => {
      if (!isRecord(block) || !Array.isArray(block.hooks)) return block;
      const nextHooks = block.hooks.filter(
        (hook) =>
          !(
            isRecord(hook) &&
            hook.type === "command" &&
            hook.command === command
          ),
      );
      if (nextHooks.length !== block.hooks.length) changed = true;
      return { ...block, hooks: nextHooks };
    })
    .filter((block) => !isRecord(block) || !Array.isArray(block.hooks) || block.hooks.length > 0);

  if (nextBlocks.length !== blocks.length) changed = true;
  if (changed) {
    if (nextBlocks.length > 0) {
      hooks[event] = nextBlocks;
    } else {
      delete hooks[event];
    }
  }
  return changed;
}

function globalCodexHookStatus(): HarnessHookStatus {
  const command = globalCodexHookCommand();
  const hooksJsonPath = globalCodexHooksJsonPath();
  const configTomlPath = globalCodexConfigTomlPath();
  const scriptPath = globalCodexHookScriptPath();
  const scriptExists = existsSync(scriptPath);
  const jsonExists = existsSync(hooksJsonPath);
  const tomlExists = existsSync(configTomlPath);
  let jsonWired = false;
  let tomlWired = false;

  if (jsonExists) {
    try {
      const config = readJsonObject(hooksJsonPath);
      jsonWired = hookEvents("codex").every((event) =>
        hookCommandExists(config, event, command),
      );
    } catch {
      jsonWired = false;
    }
  }

  if (tomlExists) {
    try {
      const content = readFileSync(configTomlPath, "utf8");
      tomlWired =
        content.includes(command) &&
        content.includes("[[hooks.UserPromptSubmit]]") &&
        content.includes("[[hooks.Stop]]");
    } catch {
      tomlWired = false;
    }
  }

  const configPath =
    jsonWired || jsonExists
      ? hooksJsonPath
      : tomlWired || tomlExists
        ? configTomlPath
        : hooksJsonPath;

  return {
    harness: "codex",
    installed: scriptExists && (jsonWired || tomlWired),
    configPath,
    scriptPath,
    configExists: jsonExists || tomlExists,
    scriptExists,
    configWired: jsonWired || tomlWired,
  };
}

function globalHarnessSetupStatus(): GlobalHarnessSetupStatus {
  return {
    codex: globalCodexHookStatus(),
    claudeCode: globalClaudeHookStatus(),
  };
}

function installGlobalCodexHooks(): GlobalHarnessSetupStatus {
  const scriptPath = globalCodexHookScriptPath();
  const command = globalCodexHookCommand();
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, globalCodexChatStatusHook(), "utf8");

  if (existsSync(globalCodexHooksJsonPath()) || !codexConfigHasInlineHooks()) {
    const configPath = globalCodexHooksJsonPath();
    mkdirSync(dirname(configPath), { recursive: true });
    const config = readJsonObject(configPath);
    for (const event of hookEvents("codex")) {
      ensureHookCommand(config, event, command);
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } else {
    ensureCodexTomlHook(command);
  }

  addLog("system", "Installed global Codex lifecycle hooks");
  return globalHarnessSetupStatus();
}

function removeGlobalCodexHooks(): GlobalHarnessSetupStatus {
  const command = globalCodexHookCommand();
  const hooksJsonPath = globalCodexHooksJsonPath();
  const configTomlPath = globalCodexConfigTomlPath();

  if (existsSync(hooksJsonPath)) {
    try {
      const config = readJsonObject(hooksJsonPath);
      let changed = false;
      for (const event of hookEvents("codex")) {
        changed = removeHookCommand(config, event, command) || changed;
      }
      if (changed) {
        writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      }
    } catch {
      // Leave malformed user config untouched.
    }
  }

  if (existsSync(configTomlPath)) {
    const current = readFileSync(configTomlPath, "utf8");
    const next = removeHitchCodexTomlBlock(current);
    if (next !== current) writeFileSync(configTomlPath, next, "utf8");
  }

  if (existsSync(globalCodexHookScriptPath())) {
    rmSync(globalCodexHookScriptPath(), { force: true });
  }

  addLog("system", "Removed global Codex lifecycle hooks");
  return globalHarnessSetupStatus();
}

function claudeHomePath(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function globalClaudeSettingsPath(): string {
  return join(claudeHomePath(), "settings.json");
}

function globalClaudeHookScriptPath(): string {
  return join(dirname(localConfigPath), "hooks", "claude-chat-status.mjs");
}

function globalClaudeHookCommand(): string {
  return `node ${shellQuote(globalClaudeHookScriptPath())}`;
}

function globalClaudeHookStatus(): HarnessHookStatus {
  const command = globalClaudeHookCommand();
  const configPath = globalClaudeSettingsPath();
  const scriptPath = globalClaudeHookScriptPath();
  const scriptExists = existsSync(scriptPath);
  const configExists = existsSync(configPath);
  let configWired = false;

  if (configExists) {
    try {
      const config = readJsonObject(configPath);
      configWired = hookEvents("claude-code").every((event) =>
        hookCommandExists(config, event, command),
      );
    } catch {
      configWired = false;
    }
  }

  return {
    harness: "claude-code",
    installed: scriptExists && configWired,
    configPath,
    scriptPath,
    configExists,
    scriptExists,
    configWired,
  };
}

function installGlobalClaudeHooks(): GlobalHarnessSetupStatus {
  const scriptPath = globalClaudeHookScriptPath();
  const command = globalClaudeHookCommand();
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, globalClaudeChatStatusHook(), "utf8");

  const configPath = globalClaudeSettingsPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const config = readJsonObject(configPath);
  for (const event of hookEvents("claude-code")) {
    ensureHookCommand(config, event, command);
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  addLog("system", "Installed global Claude Code lifecycle hooks");
  return globalHarnessSetupStatus();
}

function removeGlobalClaudeHooks(): GlobalHarnessSetupStatus {
  const command = globalClaudeHookCommand();
  const configPath = globalClaudeSettingsPath();

  if (existsSync(configPath)) {
    try {
      const config = readJsonObject(configPath);
      let changed = false;
      for (const event of hookEvents("claude-code")) {
        changed = removeHookCommand(config, event, command) || changed;
      }
      if (changed) {
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      }
    } catch {
      // Leave malformed user config untouched.
    }
  }

  if (existsSync(globalClaudeHookScriptPath())) {
    rmSync(globalClaudeHookScriptPath(), { force: true });
  }

  addLog("system", "Removed global Claude Code lifecycle hooks");
  return globalHarnessSetupStatus();
}

function firstEnabledHitchPath(): string {
  try {
    const config = readLocalConfig();
    const hitch = config.hitches.find((entry) => entry.enabled !== false);
    return hitch?.localPath ?? homedir();
  } catch {
    return homedir();
  }
}

async function openGlobalCodexHookTrust(): Promise<string> {
  const setup = globalHarnessSetupStatus();
  if (!setup.codex.installed) {
    throw new Error("Install global Codex lifecycle hooks before trusting them");
  }
  if (process.platform !== "darwin") {
    throw new Error("Opening Codex for hook trust is only supported on macOS");
  }

  const cwd = firstEnabledHitchPath();
  const prompt =
    "Review Hitch's user-level Codex hook for chat status updates. If Codex asks about hooks, approve the Hitch user hook. If needed, run /hooks.";
  const command = [
    `cd ${shellQuote(cwd)}`,
    `${shellQuote(codexBin())} -C ${shellQuote(cwd)} ${shellQuote(prompt)}`,
  ].join(" && ");
  const script = [
    'tell application "Terminal"',
    "activate",
    `do script ${JSON.stringify(command)}`,
    "end tell",
  ].join("\n");

  await run("/usr/bin/osascript", ["-e", script], { timeout: 5_000 });
  addLog("system", "Opened Codex hook trust flow for global Hitch hooks");
  return "opened";
}

async function chooseLocalPath(defaultPath?: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose project folder",
    defaultPath: defaultPath?.trim() || undefined,
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
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
  const projectId = input.projectId.trim();
  const projectName = input.projectName?.trim() || undefined;
  const localPath = resolve(input.localPath.trim());
  if (!projectId) throw new Error("Project ID is required");
  if (!localPath) throw new Error("Local path is required");
  if (!existsSync(localPath)) throw new Error(`Local path does not exist: ${localPath}`);

  const hitchPath = join(localPath, ".hitch");
  mkdirSync(hitchPath, { recursive: true });

  const config = readLocalConfig();
  const next: HitchBinding = {
    projectId,
    projectName,
    localPath,
    enabled: true,
  };

  const existingIndex = config.hitches.findIndex(
    (hitch) => hitch.projectId === projectId,
  );
  if (existingIndex >= 0) {
    config.hitches[existingIndex] = next;
  } else {
    config.hitches.push(next);
  }

  const savedConfig = writeLocalConfig(config);
  const gitignoreUpdated = input.updateGitignore === false ? false : updateGitignore(localPath);
  addLog("system", `Hitched project ${projectName ?? projectId} to ${localPath}`);
  const restarted = await restartDaemon();
  return { config: savedConfig, gitignoreUpdated, restarted };
}

function handleRunnerMessage(message: RunnerMessage): void {
  if (!isRecord(message)) return;

  if (message.type === "ready") {
    const projectId =
      typeof message.projectId === "string" ? message.projectId : "unknown";
    const localPath =
      typeof message.localPath === "string" ? message.localPath : "unknown local path";
    const hitchPath =
      typeof message.hitchPath === "string" ? message.hitchPath : join(localPath, ".hitch");
    const hitchCount = Array.isArray(message.hitches) ? message.hitches.length : 1;
    addLog(
      "system",
      hitchCount > 1
        ? `Daemon runtime ready for ${hitchCount} projects; primary project ${projectId} at ${hitchPath}`
        : `Daemon runtime ready for project ${projectId} at ${hitchPath}`,
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
  let config: LocalHitchConfig;
  try {
    ensureLocalConfig();
    config = readLocalConfig();
  } catch (err) {
    addLog("stderr", `Failed to prepare local config: ${String(err)}`);
    setStatus("stopped");
    return state();
  }

  // Nothing hitched yet (the normal fresh-install state): stay idle instead of
  // spawning a daemon that would immediately error on an empty config. The user
  // adds a project via the UI, which calls addHitch -> restartDaemon.
  if (config.hitches.filter((hitch) => hitch.enabled).length === 0) {
    addLog("system", "No projects hitched yet — daemon idle. Add a project to start syncing.");
    setStatus("stopped");
    return state();
  }

  const { command, args } = daemonRunnerCommand();
  const bakedConvexUrl = readBakedConvexUrl();
  const deviceToken = readDeviceToken();
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HITCH_ROOT: repoRoot,
      HITCH_CONFIG_PATH: localConfigPath,
      // Run the bundled daemon as plain Node under the Electron binary in prod.
      ...(isDev ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      // Point the daemon at the baked prod Convex deployment when present.
      ...(bakedConvexUrl ? { CONVEX_URL: bakedConvexUrl } : {}),
      ...(deviceToken ? { HITCH_DEVICE_TOKEN: deviceToken } : {}),
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
ipcMain.handle("config:get-project-setup", (_event, projectId: ProjectId) =>
  projectSetupStatus(projectId),
);
ipcMain.handle("config:ensure-hitch-directory", (_event, projectId: ProjectId) =>
  ensureProjectHitchDirectory(projectId),
);
ipcMain.handle("config:ensure-gitignore", (_event, projectId: ProjectId) =>
  ensureProjectGitignore(projectId),
);
ipcMain.handle("config:get-global-harness-setup", () =>
  globalHarnessSetupStatus(),
);
ipcMain.handle("config:install-global-codex-hooks", () =>
  installGlobalCodexHooks(),
);
ipcMain.handle("config:remove-global-codex-hooks", () =>
  removeGlobalCodexHooks(),
);
ipcMain.handle("config:install-global-claude-hooks", () =>
  installGlobalClaudeHooks(),
);
ipcMain.handle("config:remove-global-claude-hooks", () =>
  removeGlobalClaudeHooks(),
);
ipcMain.handle("config:open-global-codex-hook-trust", () =>
  openGlobalCodexHookTrust(),
);
ipcMain.handle("dialog:choose-local-path", (_event, defaultPath?: string) =>
  chooseLocalPath(defaultPath),
);
ipcMain.handle("device-auth:get", () => deviceAuthState());
ipcMain.handle("device-auth:set-token", (_event, token: string) =>
  saveDeviceToken(token),
);
ipcMain.handle("device-auth:clear-token", () => clearDeviceToken());

app.whenReady().then(async () => {
  // Packaged macOS builds get the dock icon from the bundled .icns; set it
  // explicitly in dev so the H shows up instead of the generic Electron icon.
  if (isDev && process.platform === "darwin") {
    const icon = nativeImage.createFromPath(
      join(__dirname, "../../../assets/icon.png"),
    );
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }

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
