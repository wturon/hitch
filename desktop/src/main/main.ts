import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from "electron";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
} from "jsonc-parser";

type DaemonStatus = "running" | "stopped" | "starting" | "stopping";
type ProjectId = string;

interface KeepAwakeState {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  error: string | null;
}

interface LogEntry {
  id: number;
  at: string;
  stream: "system" | "stdout" | "stderr";
  message: string;
}

interface ProjectConflict {
  projectId: string;
  projectName?: string;
  localPath: string;
  diskProjectId: string;
}

interface DaemonState {
  status: DaemonStatus;
  pid: number | null;
  repoRoot: string;
  configPath: string;
  logs: LogEntry[];
  conflicts: ProjectConflict[];
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

interface RemoveHitchResult {
  config: LocalHitchConfig;
  removed: boolean;
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
  configHasHook: boolean;
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
  authStorage?: Record<string, string>;
}

interface RunnerMessage {
  type?: unknown;
  stream?: unknown;
  message?: unknown;
  projectId?: unknown;
  localPath?: unknown;
  hitchPath?: unknown;
  hitches?: unknown;
  conflicts?: unknown;
  // debug-response correlation fields
  id?: unknown;
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
// Give the dev build its own identity so its Chromium cookie store and the
// keychain key Electron derives from app.name ("Hitch Dev Safe Storage") are
// separate from the installed, Developer-ID-signed production app. Otherwise the
// unsigned dev binary and the signed prod app contend over one shared
// "@hitch/desktop Safe Storage" item and macOS prompts for keychain access. Must
// run before the app is ready so the name is set before Chromium initializes.
if (isDev) app.setName("Hitch Dev");
// In dev the app lives inside the repo, so the parent of the app path is the
// repo root (used for the dev config fallback and as the daemon cwd). A packaged
// app has no repo, so anchor on the writable userData dir instead — local config
// paths are absolute, so the daemon's cwd is not load-bearing in production.
const repoRoot = process.env.HITCH_ROOT
  ? resolve(process.env.HITCH_ROOT)
  : isDev
    ? resolve(app.getAppPath(), "..")
    : app.getPath("userData");
// The dev build uses a separate app-data dir so its config (deployment-specific
// project IDs) and secrets (device token + auth, scoped to the dev Convex
// deployment) never collide with the installed production app. Mirrors the
// "Hitch Dev" split applied to app.name / the Chromium profile / the keychain key.
const appSupportDir = join(
  homedir(),
  "Library/Application Support",
  isDev ? "Hitch Dev" : "Hitch",
);
const localConfigPath =
  process.env.HITCH_CONFIG_PATH ?? join(appSupportDir, "config.json");
const localSecretsPath =
  process.env.HITCH_SECRETS_PATH ?? join(appSupportDir, "secrets.json");
// Per-harness run-environment preference (e.g. claude-code → cmux | vscode). Kept
// in its own file beside config.json so the hitches normalizer can't drop it; the
// daemon reads the same file to resolve which launcher to use.
const localPreferencesPath =
  process.env.HITCH_PREFERENCES_PATH ?? join(appSupportDir, "preferences.json");
const PROJECT_CONFIG_FILENAME = "project.json";
const devRendererUrl =
  process.env.HITCH_DESKTOP_RENDERER_URL ?? "http://127.0.0.1:5173";
// GitHub OAuth runs in the system browser (RFC 8252); Convex Auth's SITE_URL is
// set to this loopback origin so the final redirect lands back in the app. The
// port is fixed because SITE_URL is a single configured value — see startAuthLoopback.
const AUTH_LOOPBACK_PORT = 51789;
const AUTH_LOOPBACK_ORIGIN = `http://127.0.0.1:${AUTH_LOOPBACK_PORT}`;
const run = promisify(execFile);

function globalCodexChatStatusHook(): string {
  return globalChatLifecycleHook("codex");
}

function globalClaudeChatStatusHook(): string {
  return globalChatLifecycleHook("claude-code");
}

function globalChatLifecycleHook(harness: Harness): string {
  return `#!/usr/bin/env node
// Hitch user-level ${harness === "codex" ? "Codex" : "Claude Code"} lifecycle hook.
// This hook is installed globally and must never interrupt the harness. It only
// captures normalized lifecycle events into Hitch's local SQLite inbox.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

const HITCH_CONFIG_PATH = ${JSON.stringify(localConfigPath)};
const HITCH_APP_SUPPORT_DIR = ${JSON.stringify(appSupportDir)};
const HITCH_DB_PATH = HITCH_APP_SUPPORT_DIR + "/chat-lifecycle.sqlite";
const HITCH_BUMP_PATH = HITCH_APP_SUPPORT_DIR + "/chat-lifecycle.bump";
const HITCH_CODEX_CMUX_CLAIMS_PATH = HITCH_APP_SUPPORT_DIR + "/codex-cmux-launch-claims.json";
const HARNESS = ${JSON.stringify(harness)};
const PRODUCER = ${JSON.stringify(harness === "codex" ? "codex-hook" : "claude-code-hook")};

const EVENT_PLAN_BY_HARNESS = {
  codex: {
    UserPromptSubmit: { lifecycle: "turn.started", status: "working" },
    userPromptSubmit: { providerEvent: "UserPromptSubmit", lifecycle: "turn.started", status: "working" },
    PreToolUse: { lifecycle: "turn.resumed", status: "working" },
    preToolUse: { providerEvent: "PreToolUse", lifecycle: "turn.resumed", status: "working" },
    PermissionRequest: { lifecycle: "turn.needs_input", status: "needs-input" },
    permissionRequest: { providerEvent: "PermissionRequest", lifecycle: "turn.needs_input", status: "needs-input" },
    Stop: { lifecycle: "turn.completed", status: "waiting" },
    stop: { providerEvent: "Stop", lifecycle: "turn.completed", status: "waiting" },
  },
  "claude-code": {
    SessionStart: { lifecycle: "session.started", status: null },
    UserPromptSubmit: { lifecycle: "turn.started", status: "working" },
    PreToolUse: { lifecycle: "turn.resumed", status: "working" },
    Notification: { lifecycle: "turn.needs_input", status: "needs-input", requirePermissionPrompt: true },
    Stop: { lifecycle: "turn.completed", status: "waiting" },
    SessionEnd: { lifecycle: "session.ended", status: null },
  },
};

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isInside(root, cwd) {
  const rel = relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function hitchProjects() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(HITCH_CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
  if (!raw || !Array.isArray(raw.hitches)) return [];

  return raw.hitches
    .filter((entry) => entry && entry.enabled !== false)
    .map((entry) => {
      const localPath =
        typeof entry.localPath === "string" ? entry.localPath.trim() : "";
      return {
        projectId: typeof entry.projectId === "string" ? entry.projectId : null,
        localPath: localPath ? resolve(localPath) : null,
      };
    })
    .filter((entry) => entry.projectId && entry.localPath);
}

function projectForCwd(cwd) {
  const resolvedCwd = resolve(cwd || process.cwd());
  return hitchProjects().find((entry) => isInside(entry.localPath, resolvedCwd)) || null;
}

function chatId(payload) {
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
    payload.thread && payload.thread.id,
    HARNESS === "codex" ? process.env.CODEX_THREAD_ID : null,
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

  return candidates[0] || null;
}

function metadata(payload, providerEvent) {
  const out = {};
  // cmux injects CMUX_SURFACE_ID into every pane it runs, so its presence means
  // this Codex session is running inside cmux — no HITCH_CHAT_ENVIRONMENT needed
  // on the launch command. (Claude's environment is known to the daemon at
  // launch via --session-id, so it doesn't rely on this.)
  if (HARNESS === "codex" && process.env.CMUX_SURFACE_ID) {
    out.environment = "cmux";
  }
  if (typeof payload.tool_name === "string") out.toolName = payload.tool_name;
  if (typeof payload.toolName === "string") out.toolName = payload.toolName;
  if (typeof payload.notification_type === "string") {
    out.notificationType = payload.notification_type;
  }
  if (providerEvent === "SessionStart") {
    if (typeof payload.source === "string") out.source = payload.source;
    if (typeof payload.model === "string") out.model = payload.model;
    if (typeof payload.session_title === "string") out.title = payload.session_title;
  }
  if (providerEvent === "SessionEnd" && typeof payload.reason === "string") {
    out.reason = payload.reason;
  }
  if (providerEvent === "Stop" && Array.isArray(payload.background_tasks)) {
    out.backgroundTaskCount = payload.background_tasks.length;
  }
  if (providerEvent === "Stop" && Array.isArray(payload.session_crons)) {
    out.sessionCronCount = payload.session_crons.length;
  }
  return out;
}

function readCodexCmuxClaims() {
  try {
    const parsed = JSON.parse(readFileSync(HITCH_CODEX_CMUX_CLAIMS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCodexCmuxClaims(claims) {
  try {
    mkdirSync(dirname(HITCH_CODEX_CMUX_CLAIMS_PATH), { recursive: true });
    const tmpPath =
      HITCH_CODEX_CMUX_CLAIMS_PATH + "." + process.pid + "." + Date.now() + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(claims, null, 2) + "\\n", "utf8");
    renameSync(tmpPath, HITCH_CODEX_CMUX_CLAIMS_PATH);
  } catch {
    // Claim cleanup is best-effort; never interrupt the hook.
  }
}

function consumeCodexCmuxLaunchClaim(event) {
  if (HARNESS !== "codex" || event.providerEvent !== "UserPromptSubmit") {
    return null;
  }
  // cmux gives each pane a unique CMUX_SURFACE_ID; the daemon stamps the same id
  // onto the launch claim BEFORE the Codex command runs (cmuxCodex.startNew ->
  // beforeCommand), so by the time Codex fires this UserPromptSubmit the join key
  // is already on disk. Match on it deterministically — no timing fallback and no
  // guessing: each launch owns a distinct surface, so concurrent launches resolve
  // independently, and two identical-prompt launches no longer collide the way
  // the old cwd+promptHash match did.
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (!surfaceId) return null;
  const wanted = surfaceId.toLowerCase();

  const now = Date.now();
  const claims = readCodexCmuxClaims();
  const freshClaims = claims.filter((claim) => {
    return (
      claim &&
      typeof claim.createdAt === "number" &&
      now - claim.createdAt <= 10 * 60 * 1000
    );
  });
  const matches = freshClaims
    .map((claim, index) => ({ claim, index }))
    .filter(({ claim }) => {
      return (
        claim &&
        claim.claimedAt === undefined &&
        claim.environment === "cmux" &&
        typeof claim.launchId === "string" &&
        typeof claim.surfaceId === "string" &&
        claim.surfaceId.toLowerCase() === wanted
      );
    });
  if (matches.length !== 1) {
    // Prune expired claims if we dropped any; never guess when ambiguous.
    if (freshClaims.length !== claims.length) {
      writeCodexCmuxClaims(freshClaims);
    }
    return null;
  }

  const { claim, index } = matches[0];
  freshClaims[index] = {
    ...claim,
    claimedAt: now,
    chatId: event.chatId,
  };
  writeCodexCmuxClaims(freshClaims);
  return claim;
}

function codexCmuxClaimForChat(event) {
  if (HARNESS !== "codex" || !event.chatId) return null;
  const now = Date.now();
  const claims = readCodexCmuxClaims().filter((claim) => {
    return (
      claim &&
      typeof claim.createdAt === "number" &&
      now - claim.createdAt <= 10 * 60 * 1000
    );
  });
  return (
    claims.find((claim) => {
      return (
        claim &&
        claim.environment === "cmux" &&
        claim.chatId === event.chatId
      );
    }) ?? null
  );
}

function turnId(payload) {
  const id = payload.turn_id || payload.turnId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function toolUseId(payload) {
  const id = payload.tool_use_id || payload.toolUseId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function normalize(payload) {
  const hookEvent = payload.hook_event_name || payload.hookEventName;
  if (typeof hookEvent !== "string") return null;
  const plan = EVENT_PLAN_BY_HARNESS[HARNESS][hookEvent];
  if (!plan) return null;
  const providerEvent = plan.providerEvent || hookEvent;
  if (plan.requirePermissionPrompt && payload.notification_type !== "permission_prompt") {
    return null;
  }

  const id = chatId(payload);
  if (!id) return null;

  const cwd =
    typeof payload.cwd === "string" && payload.cwd.trim()
      ? payload.cwd.trim()
      : HARNESS === "codex"
        ? process.env.CODEX_PROJECT_DIR || process.env.PWD || process.cwd()
        : process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  const project = projectForCwd(cwd);
  if (!project) return null;

  const rawPayloadHash = hash(payload);
  const event = {
    schemaVersion: 1,
    source: "hook",
    producer: PRODUCER,
    harness: HARNESS,
    providerEvent,
    lifecycle: plan.lifecycle,
    status: plan.status,
    projectId: project.projectId,
    projectLocalPath: project.localPath,
    chatId: id,
    // Codex has no --session-id to pin, so the launch is correlated out-of-band
    // via the surface-keyed claim below — not an env var on the command.
    launchId: null,
    turnId: turnId(payload),
    cwd: resolve(cwd),
    host: hostname(),
    observedAt: Date.now(),
    rawPayloadHash,
    rawPayloadRef: null,
    metadata: metadata(payload, providerEvent),
  };
  const launchClaim =
    consumeCodexCmuxLaunchClaim(event) ?? codexCmuxClaimForChat(event);
  if (!event.launchId && launchClaim?.launchId) {
    event.launchId = launchClaim.launchId;
  }
  event.eventId = hash({
    source: event.source,
    producer: event.producer,
    harness: event.harness,
    providerEvent: event.providerEvent,
    chatId: event.chatId,
    launchId: event.launchId,
    turnId: event.turnId,
    toolUseId: toolUseId(payload),
    status: event.status,
    rawPayloadHash,
  });
  return event;
}

async function openDb() {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(HITCH_DB_PATH), { recursive: true });
  const db = new DatabaseSync(HITCH_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 1000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (" +
        "key TEXT PRIMARY KEY," +
        "value TEXT NOT NULL" +
      ");" +
      "CREATE TABLE IF NOT EXISTS chat_events (" +
        "seq INTEGER PRIMARY KEY AUTOINCREMENT," +
        "event_id TEXT NOT NULL UNIQUE," +
        "schema_version INTEGER NOT NULL," +
        "source TEXT NOT NULL," +
        "producer TEXT NOT NULL," +
        "harness TEXT NOT NULL," +
        "provider_event TEXT NOT NULL," +
        "lifecycle TEXT NOT NULL," +
        "status TEXT," +
        "project_id TEXT," +
        "project_local_path TEXT," +
        "chat_id TEXT," +
        "launch_id TEXT," +
        "turn_id TEXT," +
        "cwd TEXT NOT NULL," +
        "host TEXT NOT NULL," +
        "observed_at INTEGER NOT NULL," +
        "raw_payload_hash TEXT," +
        "raw_payload_ref TEXT," +
        "metadata_json TEXT NOT NULL DEFAULT '{}'," +
        "reduced_at INTEGER" +
      ");" +
      "CREATE INDEX IF NOT EXISTS chat_events_by_reducer " +
        "ON chat_events(seq) WHERE reduced_at IS NULL;" +
      "CREATE INDEX IF NOT EXISTS chat_events_by_chat " +
        "ON chat_events(harness, chat_id, seq);" +
      "CREATE INDEX IF NOT EXISTS chat_events_by_launch " +
        "ON chat_events(launch_id, seq);"
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return db;
}

async function insertEvent(event) {
  const db = await openDb();
  try {
    const result = db.prepare(
      "INSERT OR IGNORE INTO chat_events (" +
        "event_id, schema_version, source, producer, harness, provider_event, " +
        "lifecycle, status, project_id, project_local_path, chat_id, launch_id, " +
        "turn_id, cwd, host, observed_at, raw_payload_hash, raw_payload_ref, metadata_json" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      event.eventId,
      event.schemaVersion,
      event.source,
      event.producer,
      event.harness,
      event.providerEvent,
      event.lifecycle,
      event.status,
      event.projectId,
      event.projectLocalPath,
      event.chatId,
      event.launchId,
      event.turnId,
      event.cwd,
      event.host,
      event.observedAt,
      event.rawPayloadHash,
      event.rawPayloadRef,
      JSON.stringify(event.metadata || {})
    );
    if (Number(result.changes) > 0) {
      mkdirSync(dirname(HITCH_BUMP_PATH), { recursive: true });
      writeFileSync(HITCH_BUMP_PATH, String(result.lastInsertRowid) + "\\n", "utf8");
    }
  } finally {
    db.close();
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  const event = normalize(payload);
  if (event) {
    await insertEvent(event);
  }
}

main().catch(() => {
  // Never let a hook error interrupt the session.
});
`;
}

let mainWindow: BrowserWindow | null = null;
let daemon: ChildProcess | null = null;
let status: DaemonStatus = "stopped";

// In-flight debug API calls into the daemon child, keyed by request id. The
// renderer's debug screen calls these via the preload bridge; we forward over
// the child's Node IPC and resolve when the matching debug-response arrives.
const pendingDebugRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();
let debugRequestSeq = 0;

// Fail every in-flight debug request at once — called when the daemon child
// dies so the renderer's poll rejects immediately with a truthful reason
// instead of stalling for the full 15s timeout on each request.
function rejectAllPendingDebug(reason: string): void {
  for (const [, pending] of pendingDebugRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  pendingDebugRequests.clear();
}

function callDaemonDebug(
  op: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const child = daemon;
  if (!child || !child.connected) {
    return Promise.reject(new Error("Daemon is not running."));
  }
  const id = `dbg-${++debugRequestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDebugRequests.delete(id);
      reject(new Error(`Daemon debug request timed out (${op}).`));
    }, 15_000);
    pendingDebugRequests.set(id, { resolve, reject, timer });
    try {
      child.send({ type: "debug-request", id, op, ...payload });
    } catch (err) {
      // Channel closed between the connected check and send (EPIPE etc.): clean
      // up this entry's timer so it can't fire later, and reject now.
      clearTimeout(timer);
      pendingDebugRequests.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
let nextLogId = 1;
const logs: LogEntry[] = [];
const maxLogs = 500;
// Folders the running daemon refused to sync because their project.json points
// at a different project (e.g. a folder shared between the dev and prod Convex
// deployments). Repopulated from each daemon "ready" message; the renderer
// surfaces an override prompt. See handleRunnerMessage / resolveProjectConflict.
let conflicts: ProjectConflict[] = [];
let stopTimer: NodeJS.Timeout | null = null;
let quitAfterDaemonStops = false;
let updaterConfigured = false;
let lastUpdateProgressBucket = -1;
let updateCheckInterval: NodeJS.Timeout | null = null;
let keepAwakeProcess: ChildProcess | null = null;
let keepAwakeError: string | null = null;
let stoppingKeepAwake = false;

// How often to re-check for updates after the initial startup check, so a
// long-running session surfaces new versions without needing a restart.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

type UpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdaterStatus {
  // false in dev and in builds without a bundled app-update.yml, where the
  // autoUpdater never runs. The renderer uses this to explain why checking is
  // unavailable instead of showing a dead button.
  enabled: boolean;
  phase: UpdaterPhase;
  currentVersion: string;
  version: string | null;
  percent: number | null;
  error: string | null;
}

let updaterStatus: UpdaterStatus = {
  enabled: false,
  phase: "idle",
  currentVersion: app.getVersion(),
  version: null,
  percent: null,
  error: null,
};

function setUpdaterStatus(patch: Partial<UpdaterStatus>): void {
  updaterStatus = { ...updaterStatus, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:status", updaterStatus);
  }
}

function state(): DaemonState {
  return {
    status,
    pid: daemon?.pid ?? null,
    repoRoot,
    configPath: localConfigPath,
    logs,
    conflicts,
  };
}

function broadcastState(): void {
  // During quitAndInstall the window's webContents is destroyed before the
  // daemon's exit handler fires its final setStatus, so guard against a
  // destroyed window — `mainWindow?` alone stays truthy and would throw
  // "Object has been destroyed".
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("daemon:state", state());
  }
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

function isEmptyConfigValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isEmptyConfigValue);
  if (isRecord(value)) {
    return Object.values(value).every(isEmptyConfigValue);
  }
  return false;
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
  const rawAuthStorage = isRecord(raw.authStorage) ? raw.authStorage : {};
  const authStorage = Object.fromEntries(
    Object.entries(rawAuthStorage).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
  return {
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
    deviceToken: typeof raw.deviceToken === "string" ? raw.deviceToken : undefined,
    authStorage,
  };
}

function writeLocalSecrets(secrets: LocalSecrets): LocalSecrets {
  mkdirSync(dirname(localSecretsPath), { recursive: true });
  writeFileSync(localSecretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
  return readLocalSecrets();
}

// preferences.json holds several independent settings (harness environments,
// starting prompts, …). Read/write through these helpers so a write to one key
// never clobbers another — a naive `writeFile({ thatKey })` would silently drop
// every sibling setting.
function readPreferences(): Record<string, unknown> {
  if (!existsSync(localPreferencesPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(localPreferencesPath, "utf8")) as unknown;
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writePreferences(patch: Record<string, unknown>): void {
  const next = { ...readPreferences(), ...patch };
  mkdirSync(dirname(localPreferencesPath), { recursive: true });
  writeFileSync(
    localPreferencesPath,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
}

// { "claude-code": "vscode", ... }. Read defensively — a missing/garbled file is
// just "no preference set", which the daemon treats as the harness default.
function readHarnessEnvironments(): Record<string, string> {
  const stored = readPreferences().harnessEnvironments;
  if (!isRecord(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      )
      .filter(([, environment]) => environment !== "t3code"),
  );
}

function setHarnessEnvironment(
  harness: string,
  environment: string,
): Record<string, string> {
  if (environment === "t3code") {
    return readHarnessEnvironments();
  }
  const next = { ...readHarnessEnvironments(), [harness]: environment };
  writePreferences({ harnessEnvironments: next });
  return next;
}

// Small model Hitch drives to auto-title tasks. Two rails: "gpt-5.4-mini" (Codex,
// the default) and "claude-haiku-4-5" (Claude Code). The daemon reads this fresh
// per command from the same preferences.json; a missing/unknown value is the
// codex default there too, so reads and writes normalize to the known set.
const DEFAULT_TEXT_GENERATION_MODEL = "gpt-5.4-mini";
function readTextGenerationModel(): string {
  const stored = readPreferences().textGenerationModel;
  return stored === "gpt-5.4-mini" || stored === "claude-haiku-4-5"
    ? stored
    : DEFAULT_TEXT_GENERATION_MODEL;
}

function setTextGenerationModel(model: string): string {
  const next =
    model === "claude-haiku-4-5" ? "claude-haiku-4-5" : DEFAULT_TEXT_GENERATION_MODEL;
  writePreferences({ textGenerationModel: next });
  return next;
}

// Opt-in experimental feature flags. T3Code is currently hard-blocked, so reads
// and writes always normalize it to false.
function readExperimentalFlags(): Record<string, boolean> {
  const stored = readPreferences().experimental;
  if (!isRecord(stored)) return { t3code: false };
  return {
    ...Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, boolean] =>
          typeof entry[0] === "string" && typeof entry[1] === "boolean",
      ),
    ),
    t3code: false,
  };
}

function setExperimentalFlag(
  key: string,
  enabled: boolean,
): Record<string, boolean> {
  if (key === "t3code") {
    const next = { ...readExperimentalFlags(), t3code: false };
    writePreferences({ experimental: next });
    return next;
  }
  const next = { ...readExperimentalFlags(), [key]: enabled };
  writePreferences({ experimental: next });
  return next;
}

function readKeepAwakeEnabled(): boolean {
  return readPreferences().keepAwakeEnabled === true;
}

function writeKeepAwakeEnabled(enabled: boolean): void {
  writePreferences({ keepAwakeEnabled: enabled });
}

function keepAwakeState(): KeepAwakeState {
  return {
    enabled: readKeepAwakeEnabled(),
    running: keepAwakeProcess !== null,
    pid: keepAwakeProcess?.pid ?? null,
    error: keepAwakeError,
  };
}

function broadcastKeepAwakeState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("keep-awake:state", keepAwakeState());
  }
}

function startKeepAwake(persist = true): KeepAwakeState {
  if (persist) writeKeepAwakeEnabled(true);
  keepAwakeError = null;

  if (keepAwakeProcess) {
    broadcastKeepAwakeState();
    return keepAwakeState();
  }

  const child = spawn("/usr/bin/caffeinate", ["-d", "-i"], {
    stdio: "ignore",
  });
  keepAwakeProcess = child;
  stoppingKeepAwake = false;

  child.once("spawn", () => {
    broadcastKeepAwakeState();
  });
  child.once("error", (error) => {
    if (keepAwakeProcess === child) keepAwakeProcess = null;
    keepAwakeError = error.message;
    broadcastKeepAwakeState();
  });
  child.once("exit", (code, signal) => {
    if (keepAwakeProcess === child) keepAwakeProcess = null;
    if (!stoppingKeepAwake && readKeepAwakeEnabled()) {
      keepAwakeError = `caffeinate exited${signal ? ` with signal ${signal}` : ` with code ${code}`}`;
    }
    stoppingKeepAwake = false;
    broadcastKeepAwakeState();
  });

  broadcastKeepAwakeState();
  return keepAwakeState();
}

function stopKeepAwake(persist = true): KeepAwakeState {
  if (persist) writeKeepAwakeEnabled(false);
  keepAwakeError = null;

  if (!keepAwakeProcess) {
    broadcastKeepAwakeState();
    return keepAwakeState();
  }

  stoppingKeepAwake = true;
  keepAwakeProcess.kill("SIGTERM");
  broadcastKeepAwakeState();
  return keepAwakeState();
}

// The user's CUSTOM kickoff prompts, picked from the delegation dropdown.
// Consumed only by the renderer; the daemon never reads these. The curated
// built-in prompts live in the app binary (BUILTIN_STARTING_PROMPTS in
// desktop/src/renderer/lib/chat.ts) and are never stored here — only the user's
// own prompts are. Keep StoredStartingPrompt in sync with that file's
// StartingPrompt shape.
interface StoredStartingPrompt {
  id: string;
  name: string;
  body: string;
  includeTaskRef: boolean;
}

// Ids reserved for the built-in prompts. Custom prompts may never use them, so
// any built-in copy a user had seeded into their library before the split is
// stripped on read and rejected on write — the binary's built-ins always win.
// Mirror of BUILTIN_PROMPT_IDS in desktop/src/renderer/lib/chat.ts.
const BUILTIN_PROMPT_IDS = new Set([
  "default-execute",
  "think-through",
  "refine-task",
  "investigate",
]);

function sanitizeStartingPrompt(value: unknown): StoredStartingPrompt | null {
  if (!isRecord(value)) return null;
  const { id, name, body, includeTaskRef } = value;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (BUILTIN_PROMPT_IDS.has(id)) return null;
  return {
    id,
    name,
    body: typeof body === "string" ? body : "",
    includeTaskRef: includeTaskRef !== false,
  };
}

// Returns the user's stored custom prompts. Built-in ids are stripped so a
// pre-split library that had the seeded built-ins baked in collapses to just the
// custom entries (usually none). The renderer prepends the binary's built-ins.
function readStartingPrompts(): StoredStartingPrompt[] {
  const stored = readPreferences().startingPrompts;
  if (!Array.isArray(stored)) return [];
  return stored
    .map(sanitizeStartingPrompt)
    .filter((p): p is StoredStartingPrompt => p !== null);
}

function setStartingPrompts(prompts: unknown): StoredStartingPrompt[] {
  const sanitized = Array.isArray(prompts)
    ? prompts
        .map(sanitizeStartingPrompt)
        .filter((p): p is StoredStartingPrompt => p !== null)
    : [];
  writePreferences({ startingPrompts: sanitized });
  return readStartingPrompts();
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
  writeLocalSecrets({
    ...secrets,
    deviceId: secrets.deviceId ?? ensureDeviceId(),
    deviceToken: undefined,
  });
  addLog("system", "Cleared local device authorization");
  await restartDaemon();
  return deviceAuthState();
}

function authStorageGet(key: string): string | null {
  return readLocalSecrets().authStorage?.[key] ?? null;
}

function authStorageSet(key: string, value: string): void {
  const secrets = readLocalSecrets();
  writeLocalSecrets({
    ...secrets,
    authStorage: {
      ...(secrets.authStorage ?? {}),
      [key]: value,
    },
  });
}

function authStorageRemove(key: string): void {
  const secrets = readLocalSecrets();
  const authStorage = { ...(secrets.authStorage ?? {}) };
  delete authStorage[key];
  writeLocalSecrets({ ...secrets, authStorage });
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

function readExistingHitchProjectId(localPath: string): string | null {
  const configPath = join(localPath, ".hitch", PROJECT_CONFIG_FILENAME);
  if (!existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Could not read existing .hitch/${PROJECT_CONFIG_FILENAME}: ${String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Existing .hitch/${PROJECT_CONFIG_FILENAME} must be a JSON object`);
  }
  const existingProjectId =
    typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
  if (!existingProjectId) {
    throw new Error(`Existing .hitch/${PROJECT_CONFIG_FILENAME} is missing projectId`);
  }
  return existingProjectId;
}

// Rewrite the projectId baked into a folder's .hitch/project.json, preserving
// every other field (name, statuses, …). Used to resolve a cross-environment
// conflict: the file's body is the other deployment's metadata, but pointing it
// at this deployment's project id lets the daemon adopt it on the next sync.
function writeHitchProjectId(localPath: string, projectId: string): void {
  const configPath = join(localPath, ".hitch", PROJECT_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    throw new Error(`No .hitch/${PROJECT_CONFIG_FILENAME} to rewrite at ${localPath}`);
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Existing .hitch/${PROJECT_CONFIG_FILENAME} must be a JSON object`);
  }
  const next = { ...parsed, projectId };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// User confirmed the override prompt: rewrite the folder's project.json to this
// environment's project id and restart the daemon, which re-checks and now syncs
// the folder (union of local ∪ server). See daemon startHitchBinding.
async function resolveProjectConflict(projectId: ProjectId): Promise<DaemonState> {
  const trimmed = projectId.trim();
  const conflict = conflicts.find((entry) => entry.projectId === trimmed);
  if (!conflict) return state();

  writeHitchProjectId(conflict.localPath, trimmed);
  addLog(
    "system",
    `Overrode project.json at ${conflict.localPath}: ${conflict.diskProjectId} → ${trimmed}`,
  );
  conflicts = conflicts.filter((entry) => entry.projectId !== trimmed);
  broadcastState();
  await restartDaemon();
  return state();
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

// The lifecycle events each harness wires to the chat-status hook. `matcher`
// (Claude only) scopes a hook to a notification subtype — Notification fires for
// permission/idle/auth pings, but we only care about permission prompts.
interface HookEvent {
  event: string;
  matcher?: string;
}

function hookEvents(harness: Harness): HookEvent[] {
  if (harness === "codex") {
    return [
      { event: "UserPromptSubmit" },
      { event: "PermissionRequest" },
      { event: "PreToolUse" },
      { event: "Stop" },
    ];
  }
  return [
    { event: "UserPromptSubmit" },
    { event: "PreToolUse" },
    { event: "Notification", matcher: "permission_prompt" },
    { event: "Stop" },
    { event: "SessionStart" },
    { event: "SessionEnd" },
  ];
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function blockMatches(block: Record<string, unknown>, matcher?: string): boolean {
  const blockMatcher =
    typeof block.matcher === "string" && block.matcher ? block.matcher : undefined;
  return blockMatcher === matcher;
}

function hookCommandExists(
  config: Record<string, unknown>,
  event: string,
  command: string,
  matcher?: string,
): boolean {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
  return blocks.some((block) => {
    if (!isRecord(block) || !Array.isArray(block.hooks)) return false;
    if (!blockMatches(block, matcher)) return false;
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
  matcher?: string,
): void {
  if (!isRecord(config.hooks)) config.hooks = {};
  const hooks = config.hooks;
  if (!isRecord(hooks)) throw new Error("hooks must be a JSON object");
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const blocks = hooks[event];
  if (!Array.isArray(blocks)) throw new Error(`hooks.${event} must be an array`);
  if (hookCommandExists(config, event, command, matcher)) return;
  blocks.push({
    ...(matcher ? { matcher } : {}),
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

const CMUX_CANDIDATES = [
  process.env.CMUX_BIN,
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
  "cmux",
].filter((value): value is string => Boolean(value));

function cmuxBin(): string {
  for (const candidate of CMUX_CANDIDATES) {
    if (candidate === "cmux" || existsSync(candidate)) return candidate;
  }
  return "cmux";
}

function cmuxConfigPath(): string {
  return join(homedir(), ".config", "cmux", "cmux.json");
}

function cmuxAppPath(): string | null {
  const bin = cmuxBin();
  const marker = "/Contents/Resources/bin/";
  const idx = bin.indexOf(marker);
  return idx >= 0 ? bin.slice(0, idx) : null;
}

// The socket mode that lets a Dock-launched Hitch drive cmux. "automation" drops
// cmux's ancestry check but keeps the socket owner-only, so it's the
// least-permissive mode that unblocks us.
const CMUX_SOCKET_MODE = "automation";

type EnableCmuxStatus = "created" | "updated" | "already-enabled";

export interface EnableCmuxResult {
  status: EnableCmuxStatus;
  configPath: string;
  backupPath?: string;
}

// Set automation.socketControlMode in cmux's config so cmux stops refusing
// Hitch. We can't go through cmux's CLI/socket here — that's the very channel
// being blocked (its ancestry check rejects us, the same Broken pipe the daemon
// hits) — so we edit ~/.config/cmux/cmux.json directly. jsonc-parser's modify()
// preserves the file's comments/formatting and only rewrites the one key, and
// we back up the original first (cmux's own docs recommend this). The new mode
// binds when cmux next starts, so the UI tells the user to restart cmux.
async function enableCmuxAutomation(): Promise<EnableCmuxResult> {
  const configPath = cmuxConfigPath();

  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    const fresh =
      `{\n` +
      `  "$schema": "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",\n` +
      `  "schemaVersion": 1,\n` +
      `  "automation": {\n` +
      `    "socketControlMode": "${CMUX_SOCKET_MODE}"\n` +
      `  }\n` +
      `}\n`;
    writeFileSync(configPath, fresh, "utf8");
    addLog("system", `Created ${configPath} with cmux socket mode "${CMUX_SOCKET_MODE}"`);
    return { status: "created", configPath };
  }

  const raw = readFileSync(configPath, "utf8");
  const current = parseJsonc(raw) as
    | { automation?: { socketControlMode?: string } }
    | undefined;
  if (current?.automation?.socketControlMode === CMUX_SOCKET_MODE) {
    addLog("system", `cmux socket mode already "${CMUX_SOCKET_MODE}" in ${configPath}`);
    return { status: "already-enabled", configPath };
  }

  const backupPath = `${configPath}.hitchbak-${Date.now()}`;
  writeFileSync(backupPath, raw, "utf8");

  const edits = modifyJsonc(
    raw,
    ["automation", "socketControlMode"],
    CMUX_SOCKET_MODE,
    { formattingOptions: { insertSpaces: true, tabSize: 2 } },
  );
  writeFileSync(configPath, applyJsoncEdits(raw, edits), "utf8");
  addLog(
    "system",
    `Set cmux socket mode to "${CMUX_SOCKET_MODE}" in ${configPath} (backup: ${backupPath})`,
  );
  return { status: "updated", configPath, backupPath };
}

// Bring cmux to the foreground / launch it if it isn't running. LaunchServices
// (`open`), not the socket, so it works regardless of cmux's socket mode. Used
// when cmux isn't reachable at all.
async function openCmuxApp(): Promise<string> {
  const appPath = cmuxAppPath();
  await run("/usr/bin/open", appPath ? ["-a", appPath] : ["-a", "cmux"], {
    timeout: 5_000,
  });
  addLog("system", "Opened cmux");
  return "opened";
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
  const scriptCurrent =
    scriptExists &&
    (() => {
      try {
        return readFileSync(scriptPath, "utf8") === globalCodexChatStatusHook();
      } catch {
        return false;
      }
    })();
  const jsonExists = existsSync(hooksJsonPath);
  const tomlExists = existsSync(configTomlPath);
  let jsonWired = false;
  let jsonHasHook = false;
  let tomlWired = false;
  let tomlHasHook = false;

  if (jsonExists) {
    try {
      const config = readJsonObject(hooksJsonPath);
      jsonHasHook = hookEvents("codex").some(({ event, matcher }) =>
        hookCommandExists(config, event, command, matcher),
      );
      jsonWired = hookEvents("codex").every(({ event, matcher }) =>
        hookCommandExists(config, event, command, matcher),
      );
    } catch {
      jsonWired = false;
    }
  }

  if (tomlExists) {
    try {
      const content = readFileSync(configTomlPath, "utf8");
      tomlHasHook = content.includes(command);
      tomlWired =
        content.includes(command) &&
        content.includes("[[hooks.UserPromptSubmit]]") &&
        content.includes("[[hooks.PermissionRequest]]") &&
        content.includes("[[hooks.PreToolUse]]") &&
        content.includes("[[hooks.Stop]]");
    } catch {
      tomlWired = false;
    }
  }

  const configPath =
    jsonHasHook
      ? hooksJsonPath
      : tomlHasHook
        ? configTomlPath
        : jsonExists
          ? hooksJsonPath
          : tomlExists
            ? configTomlPath
            : hooksJsonPath;

  return {
    harness: "codex",
    installed: scriptCurrent && (jsonWired || tomlWired),
    configPath,
    scriptPath,
    configExists: jsonExists || tomlExists,
    configHasHook: jsonHasHook || tomlHasHook,
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

type IntegrationLevel = "harness" | "environment";
type IntegrationOwner = "hitch" | "delegated";
type IntegrationState = "ok" | "missing" | "drifted" | "broken" | "quiet";
type IntegrationId =
  | "codex.hitch-lifecycle-hooks"
  | "claude.hitch-lifecycle-hooks"
  | "cmux.socket-automation"
  | "cmux.codex-hooks";

interface IntegrationStatus {
  id: IntegrationId;
  label: string;
  group: "Codex" | "Claude Code" | "cmux";
  level: IntegrationLevel;
  owner: IntegrationOwner;
  applies: boolean;
  state: IntegrationState;
  reason: string;
  targetPaths: string[];
  canRepair: boolean;
  repairLabel: string;
}

interface IntegrationHealth {
  checkedAt: string;
  integrations: IntegrationStatus[];
}

function effectiveHarnessEnvironments(): Record<"claude-code" | "codex", string> {
  const stored = readHarnessEnvironments();
  return {
    "claude-code": stored["claude-code"] || "cmux",
    codex: stored.codex || "codex-app",
  };
}

async function cmuxCliAvailable(): Promise<boolean> {
  try {
    await run(cmuxBin(), ["--version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function commandIncludes(config: Record<string, unknown>, event: string, needle: string): boolean {
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
  return blocks.some((block) => {
    if (!isRecord(block) || !Array.isArray(block.hooks)) return false;
    return block.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.type === "command" &&
        typeof hook.command === "string" &&
        hook.command.includes(needle),
    );
  });
}

function cmuxCodexHookInstalled(): boolean {
  const hooksJsonPath = globalCodexHooksJsonPath();
  if (!existsSync(hooksJsonPath)) return false;
  try {
    const config = readJsonObject(hooksJsonPath);
    return (
      commandIncludes(config, "SessionStart", "hooks codex session-start") &&
      commandIncludes(config, "UserPromptSubmit", "hooks codex prompt-submit") &&
      commandIncludes(config, "Stop", "hooks codex stop") &&
      commandIncludes(config, "PreToolUse", "hooks feed --source codex") &&
      commandIncludes(config, "PermissionRequest", "hooks feed --source codex")
    );
  } catch {
    return false;
  }
}

function harnessHookIntegrationStatus(
  id: Extract<
    IntegrationId,
    "codex.hitch-lifecycle-hooks" | "claude.hitch-lifecycle-hooks"
  >,
  label: string,
  group: "Codex" | "Claude Code",
  status: HarnessHookStatus,
): IntegrationStatus {
  const hasFootprint = status.scriptExists || status.configHasHook;
  const state: IntegrationState = status.installed
    ? "ok"
    : hasFootprint
      ? "drifted"
      : "quiet";
  const reason = status.installed
    ? "Lifecycle hooks match Hitch's current desired state."
    : hasFootprint
      ? "Hitch-owned hook files or config entries are present but incomplete or stale."
      : "Lifecycle hooks are not installed. Install them to show live chat status on task cards.";
  return {
    id,
    label,
    group,
    level: "harness",
    owner: "hitch",
    applies: hasFootprint || status.installed,
    state,
    reason,
    targetPaths: [status.configPath, status.scriptPath].filter(
      (path): path is string => Boolean(path),
    ),
    canRepair: true,
    repairLabel: status.installed ? "Repair" : hasFootprint ? "Heal" : "Install",
  };
}

function cmuxSocketIntegrationStatus(): IntegrationStatus {
  const envs = effectiveHarnessEnvironments();
  const applies = envs["claude-code"] === "cmux" || envs.codex === "cmux";
  const configPath = cmuxConfigPath();
  if (!applies) {
    return {
      id: "cmux.socket-automation",
      label: "Socket permissions",
      group: "cmux",
      level: "environment",
      owner: "hitch",
      applies: false,
      state: "quiet",
      reason: "No harness is configured to run in cmux.",
      targetPaths: [configPath],
      canRepair: false,
      repairLabel: "Enable",
    };
  }
  if (!existsSync(configPath)) {
    return {
      id: "cmux.socket-automation",
      label: "Socket permissions",
      group: "cmux",
      level: "environment",
      owner: "hitch",
      applies: true,
      state: "missing",
      reason: "cmux automation socket mode is not configured.",
      targetPaths: [configPath],
      canRepair: true,
      repairLabel: "Enable",
    };
  }
  try {
    const parsed = parseJsonc(readFileSync(configPath, "utf8")) as
      | { automation?: { socketControlMode?: string } }
      | undefined;
    const mode = parsed?.automation?.socketControlMode;
    const ok = mode === CMUX_SOCKET_MODE;
    return {
      id: "cmux.socket-automation",
      label: "Socket permissions",
      group: "cmux",
      level: "environment",
      owner: "hitch",
      applies: true,
      state: ok ? "ok" : "drifted",
      reason: ok
        ? "cmux automation socket mode is enabled."
        : `cmux socket mode is ${mode ? `"${mode}"` : "unset"}; Hitch needs "${CMUX_SOCKET_MODE}".`,
      targetPaths: [configPath],
      canRepair: true,
      repairLabel: ok ? "Repair" : "Enable",
    };
  } catch (err) {
    return {
      id: "cmux.socket-automation",
      label: "Socket permissions",
      group: "cmux",
      level: "environment",
      owner: "hitch",
      applies: true,
      state: "broken",
      reason: `Could not read cmux config: ${err instanceof Error ? err.message : String(err)}`,
      targetPaths: [configPath],
      canRepair: false,
      repairLabel: "Repair",
    };
  }
}

async function cmuxCodexHooksIntegrationStatus(): Promise<IntegrationStatus> {
  const envs = effectiveHarnessEnvironments();
  const applies = envs.codex === "cmux";
  const targets = [globalCodexHooksJsonPath(), globalCodexConfigTomlPath()];
  if (!applies) {
    return {
      id: "cmux.codex-hooks",
      label: "Codex hooks",
      group: "cmux",
      level: "environment",
      owner: "delegated",
      applies: false,
      state: "quiet",
      reason: "Codex is not configured to run in cmux.",
      targetPaths: targets,
      canRepair: false,
      repairLabel: "Install",
    };
  }
  if (!(await cmuxCliAvailable())) {
    return {
      id: "cmux.codex-hooks",
      label: "Codex hooks",
      group: "cmux",
      level: "environment",
      owner: "delegated",
      applies: true,
      state: "broken",
      reason: "cmux CLI is not available, so Hitch cannot check or install cmux's Codex hooks.",
      targetPaths: targets,
      canRepair: false,
      repairLabel: "Install",
    };
  }
  const installed = cmuxCodexHookInstalled();
  return {
    id: "cmux.codex-hooks",
    label: "Codex hooks",
    group: "cmux",
    level: "environment",
    owner: "delegated",
    applies: true,
    state: installed ? "ok" : "missing",
    reason: installed
      ? "cmux's Codex hooks are present in Codex hook config."
      : "Codex is configured for cmux, but cmux's Codex hooks are not installed.",
    targetPaths: targets,
    canRepair: true,
    repairLabel: "Install",
  };
}

async function integrationHealth(): Promise<IntegrationHealth> {
  const setup = globalHarnessSetupStatus();
  return {
    checkedAt: new Date().toISOString(),
    integrations: [
      harnessHookIntegrationStatus(
        "codex.hitch-lifecycle-hooks",
        "Hitch lifecycle hooks",
        "Codex",
        setup.codex,
      ),
      harnessHookIntegrationStatus(
        "claude.hitch-lifecycle-hooks",
        "Hitch lifecycle hooks",
        "Claude Code",
        setup.claudeCode,
      ),
      cmuxSocketIntegrationStatus(),
      await cmuxCodexHooksIntegrationStatus(),
    ],
  };
}

async function repairIntegration(id: IntegrationId): Promise<IntegrationHealth> {
  switch (id) {
    case "codex.hitch-lifecycle-hooks":
      installGlobalCodexHooks();
      break;
    case "claude.hitch-lifecycle-hooks":
      installGlobalClaudeHooks();
      break;
    case "cmux.socket-automation":
      await enableCmuxAutomation();
      break;
    case "cmux.codex-hooks":
      installCmuxCodexHook();
      break;
  }
  return integrationHealth();
}

async function repairAllIntegrations(): Promise<IntegrationHealth> {
  const health = await integrationHealth();
  for (const integration of health.integrations) {
    if (
      integration.applies &&
      integration.canRepair &&
      integration.state !== "ok" &&
      integration.state !== "quiet"
    ) {
      await repairIntegration(integration.id);
    }
  }
  return integrationHealth();
}

// On upgrade, a prior Hitch version's lifecycle-hook script can drift from what
// this build expects (the embedded hook script content changed across versions).
// Settings surfaces that as "drifted" and offers a manual "Heal", but a user who
// never opens Settings would silently get stale/absent chat status on their task
// cards. So heal drifted harness hooks automatically at startup — but ONLY when
// there's an existing Hitch footprint that's stale ("drifted"). We never silently
// install hooks for someone who never had them ("quiet"); that stays an opt-in via
// Settings. Reuses harnessHookIntegrationStatus so "drifted" means exactly what the
// Settings panel shows. Runs before the daemon so status flows on the first
// post-upgrade launch instead of waiting for a Settings visit.
function healDriftedHarnessHooks(): void {
  const setup = globalHarnessSetupStatus();
  const targets: Array<{ status: IntegrationStatus; install: () => unknown }> = [
    {
      status: harnessHookIntegrationStatus(
        "claude.hitch-lifecycle-hooks",
        "Hitch lifecycle hooks",
        "Claude Code",
        setup.claudeCode,
      ),
      install: installGlobalClaudeHooks,
    },
    {
      status: harnessHookIntegrationStatus(
        "codex.hitch-lifecycle-hooks",
        "Hitch lifecycle hooks",
        "Codex",
        setup.codex,
      ),
      install: installGlobalCodexHooks,
    },
  ];
  for (const { status, install } of targets) {
    if (status.state !== "drifted") continue;
    try {
      install();
      addLog(
        "system",
        `Auto-healed drifted ${status.group} lifecycle hooks on startup`,
      );
    } catch (err) {
      addLog(
        "system",
        `Failed to auto-heal ${status.group} lifecycle hooks: ${String(err)}`,
      );
    }
  }
}

function installGlobalCodexHooks(): GlobalHarnessSetupStatus {
  const scriptPath = globalCodexHookScriptPath();
  const command = globalCodexHookCommand();
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, globalCodexChatStatusHook(), "utf8");

  // Codex treats ~/.codex/hooks.json as the first-class hook representation and
  // warns ("loading hooks from both …") when hooks ALSO live in config.toml. So
  // always install into hooks.json — merge-safe via ensureHookCommand, which
  // preserves any other hooks already there (e.g. cmux's) — and migrate any
  // legacy inline Hitch block out of config.toml so there's a single
  // representation. This is independent of cmux: every Codex user gets it.
  const hooksJsonPath = globalCodexHooksJsonPath();
  mkdirSync(dirname(hooksJsonPath), { recursive: true });
  const config = readJsonObject(hooksJsonPath);
  for (const { event, matcher } of hookEvents("codex")) {
    ensureHookCommand(config, event, command, matcher);
  }
  writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const tomlPath = globalCodexConfigTomlPath();
  if (existsSync(tomlPath)) {
    const current = readFileSync(tomlPath, "utf8");
    const migrated = removeHitchCodexTomlBlock(current);
    if (migrated !== current) {
      writeFileSync(tomlPath, migrated, "utf8");
      addLog("system", "Migrated Codex hooks from config.toml to hooks.json");
    }
  }

  addLog("system", "Installed global Codex lifecycle hooks");
  return globalHarnessSetupStatus();
}

// One-time, cmux-independent migration: older installs wrote Hitch's Codex
// hooks inline into ~/.codex/config.toml. Codex now prefers hooks.json and warns
// when both carry hooks, so on startup we move any legacy block over. Gated on
// the block actually being present, so users who never had Codex hooks don't get
// a hooks.json created for them.
function migrateCodexHooksRepresentation(): void {
  const tomlPath = globalCodexConfigTomlPath();
  if (!existsSync(tomlPath)) return;
  if (!readFileSync(tomlPath, "utf8").includes(HITCH_CODEX_TOML_START)) return;
  installGlobalCodexHooks();
}

// Install cmux's own Codex lifecycle hook so cmux — not Hitch — owns the Codex
// resume binding, exactly as cmux's native Claude wrapper owns it for Claude. On
// session start cmux's hook records the per-surface session binding
// (surface.resume.get → checkpoint_id) that openChat's findSurfaceUuid reads to
// focus-vs-spawn, and it resumes Codex on app relaunch via `codex resume <id>`.
// That lets Hitch stop hand-writing resume commands — which carried a per-thread
// prefix that never matched a prior approval, so cmux popped "Allow Resume
// Command?" every session.
//
// `cmux hooks codex install` MERGES into ~/.codex/hooks.json (appends cmux's
// block, leaves Hitch's lifecycle hook at index 0 with its existing trust) and
// self-trusts only cmux's hook in config.toml. It's idempotent — no-ops when
// already current — so we call it unconditionally at startup, after the
// migration that guarantees Hitch's hook sits in hooks.json first. If cmux is
// absent or refuses the call it's non-fatal: Codex still launches; only
// cmux-owned resume is unavailable until cmux is present.
function installCmuxCodexHook(): void {
  // Back up hooks.json once before cmux first touches it. The merge is
  // test-verified, not doc-guaranteed, so keep a one-time safety copy.
  try {
    const hooksJsonPath = globalCodexHooksJsonPath();
    const backupPath = `${hooksJsonPath}.pre-cmux-hook.bak`;
    if (existsSync(hooksJsonPath) && !existsSync(backupPath)) {
      copyFileSync(hooksJsonPath, backupPath);
      addLog("system", `Backed up Codex hooks.json before cmux hook install: ${backupPath}`);
    }
  } catch {
    // Best-effort backup; never block the install.
  }
  try {
    execFileSync(cmuxBin(), ["hooks", "codex", "install", "--yes"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    addLog("system", "Installed cmux Codex hook (cmux owns the Codex resume binding)");
  } catch (err) {
    addLog(
      "system",
      `Skipped cmux Codex hook install: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function removeGlobalCodexHooks(): GlobalHarnessSetupStatus {
  const command = globalCodexHookCommand();
  const hooksJsonPath = globalCodexHooksJsonPath();
  const configTomlPath = globalCodexConfigTomlPath();

  if (existsSync(hooksJsonPath)) {
    try {
      const config = readJsonObject(hooksJsonPath);
      let changed = false;
      for (const { event } of hookEvents("codex")) {
        changed = removeHookCommand(config, event, command) || changed;
      }
      if (changed) {
        if (isEmptyConfigValue(config)) {
          rmSync(hooksJsonPath, { force: true });
        } else {
          writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        }
      }
    } catch {
      // Leave malformed user config untouched.
    }
  }

  if (existsSync(configTomlPath)) {
    const current = readFileSync(configTomlPath, "utf8");
    const next = removeHitchCodexTomlBlock(current);
    if (next !== current) {
      if (next.trim()) {
        writeFileSync(configTomlPath, next, "utf8");
      } else {
        rmSync(configTomlPath, { force: true });
      }
    }
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
  let configHasHook = false;
  let configWired = false;

  if (configExists) {
    try {
      const config = readJsonObject(configPath);
      configHasHook = hookEvents("claude-code").some(({ event, matcher }) =>
        hookCommandExists(config, event, command, matcher),
      );
      configWired = hookEvents("claude-code").every(({ event, matcher }) =>
        hookCommandExists(config, event, command, matcher),
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
    configHasHook,
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
  for (const { event, matcher } of hookEvents("claude-code")) {
    ensureHookCommand(config, event, command, matcher);
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
      for (const { event } of hookEvents("claude-code")) {
        changed = removeHookCommand(config, event, command) || changed;
      }
      if (changed) {
        if (isEmptyConfigValue(config)) {
          rmSync(configPath, { force: true });
        } else {
          writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        }
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
  const command = [
    `cd ${shellQuote(cwd)}`,
    `${shellQuote(codexBin())} -C ${shellQuote(cwd)}`,
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

  // A folder whose project.json names a different project usually means it was
  // last synced against another Convex deployment (the dev⇄prod shared-folder
  // case). Don't hard-block: create the binding anyway and let the daemon detect
  // the mismatch and surface an explicit override prompt, rather than dead-end
  // here before the daemon ever runs.
  const existingProjectId = readExistingHitchProjectId(localPath);
  if (existingProjectId && existingProjectId !== projectId) {
    addLog(
      "system",
      `Hitching ${localPath} to ${projectId}, but its project.json names ${existingProjectId} — the daemon will prompt to override`,
    );
  }

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

async function removeHitch(projectId: ProjectId): Promise<RemoveHitchResult> {
  const trimmed = projectId.trim();
  if (!trimmed) throw new Error("Project ID is required");

  const config = readLocalConfig();
  const nextHitches = config.hitches.filter(
    (hitch) => hitch.projectId !== trimmed,
  );
  const removed = nextHitches.length !== config.hitches.length;
  if (!removed) {
    return { config, removed: false, restarted: false };
  }

  const savedConfig = writeLocalConfig({ hitches: nextHitches });
  addLog("system", `Unhitched project ${trimmed}`);
  const restarted = daemon ? await restartDaemon() : false;
  return { config: savedConfig, removed: true, restarted };
}

function parseConflicts(value: unknown): ProjectConflict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ProjectConflict[] => {
    if (
      isRecord(entry) &&
      typeof entry.projectId === "string" &&
      typeof entry.localPath === "string" &&
      typeof entry.diskProjectId === "string"
    ) {
      return [
        {
          projectId: entry.projectId,
          projectName:
            typeof entry.projectName === "string" ? entry.projectName : undefined,
          localPath: entry.localPath,
          diskProjectId: entry.diskProjectId,
        },
      ];
    }
    return [];
  });
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
    conflicts = parseConflicts(message.conflicts);
    for (const conflict of conflicts) {
      addLog(
        "system",
        `Project ID mismatch at ${conflict.localPath}: project.json points at ${conflict.diskProjectId}, expected ${conflict.projectId} — not syncing until resolved`,
      );
    }
    setStatus("running");
    broadcastState();
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

  if (message.type === "debug-response") {
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;
    const pending = pendingDebugRequests.get(id);
    if (!pending) return;
    pendingDebugRequests.delete(id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(String(message.error ?? "Debug request failed.")));
    return;
  }

  if (message.type === "stopped") {
    addLog("system", "Daemon runtime stopped");
  }
}

function startDaemon(): DaemonState {
  if (daemon) return state();

  // Stale until the fresh daemon reports its conflicts in the "ready" message.
  conflicts = [];
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
    rejectAllPendingDebug("Daemon failed to start.");
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
    rejectAllPendingDebug("Daemon stopped.");
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

function updateConfigPath(): string {
  return join(process.resourcesPath, "app-update.yml");
}

function updateVersionLabel(info: UpdateInfo): string {
  return info.version ? `version ${info.version}` : "a new version";
}


function configureAutoUpdates(): void {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (isDev) {
    addLog("system", "Auto updates disabled in development");
    return;
  }

  if (!existsSync(updateConfigPath())) {
    addLog(
      "system",
      "Auto updates disabled: no app-update.yml was bundled. Set HITCH_UPDATE_FEED_URL before packaging to enable beta updates.",
    );
    return;
  }

  setUpdaterStatus({ enabled: true });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // The renderer surfaces update state in an in-app sidebar banner and the
  // settings dialog. Each event updates the broadcast status; download and
  // restart are driven by the user via IPC (autoDownload is off), replacing the
  // native message-box prompts we used to show here.
  autoUpdater.on("checking-for-update", () => {
    addLog("system", "Checking for Hitch updates");
    setUpdaterStatus({ phase: "checking", error: null });
  });

  autoUpdater.on("update-not-available", () => {
    addLog("system", "Hitch is up to date");
    setUpdaterStatus({ phase: "up-to-date", version: null, percent: null });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    addLog("system", `Update available: ${updateVersionLabel(info)}`);
    lastUpdateProgressBucket = -1;
    setUpdaterStatus({
      phase: "available",
      version: info.version ?? null,
      percent: null,
      error: null,
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    setUpdaterStatus({ phase: "downloading", percent: Math.round(progress.percent) });
    const bucket = Math.floor(progress.percent / 10) * 10;
    if (bucket === lastUpdateProgressBucket) return;
    lastUpdateProgressBucket = bucket;
    addLog("system", `Update download ${bucket}%`);
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    addLog("system", `Update downloaded: ${updateVersionLabel(info)}`);
    setUpdaterStatus({
      phase: "downloaded",
      version: info.version ?? null,
      percent: 100,
    });
  });

  autoUpdater.on("error", (error: Error) => {
    addLog("stderr", `Update check failed: ${error.message}`);
    setUpdaterStatus({ phase: "error", error: error.message });
  });

  const runCheck = () => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      addLog("stderr", `Update check failed: ${String(error)}`);
    });
  };

  setTimeout(runCheck, 5_000);
  updateCheckInterval = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);
}

// Convex Auth starts OAuth by navigating the window to
// {CONVEX_SITE}/api/auth/signin/<provider>, which then 302s to the provider
// (github.com). We send that whole flow to the system browser instead of the
// embedded window — matching both the signin entrypoint and the provider host so
// it works whether the hop arrives as a navigation or an HTTP redirect.
function isExternalSignInUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      url.pathname.startsWith("/api/auth/signin/") ||
      url.hostname === "github.com"
    );
  } catch {
    return false;
  }
}

let authLoopbackServer: Server | null = null;

// Receives Convex Auth's final OAuth redirect after the system-browser round-trip
// (SITE_URL -> http://127.0.0.1:51789/?code=...) and hands the code to the renderer,
// which holds the PKCE verifier and completes the token exchange.
function startAuthLoopback(): void {
  if (authLoopbackServer) return;
  const server = createServer((req, res) => {
    let code: string | null = null;
    try {
      code = new URL(req.url ?? "/", AUTH_LOOPBACK_ORIGIN).searchParams.get(
        "code",
      );
    } catch {
      code = null;
    }
    res.writeHead(code ? 200 : 404, {
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(authLoopbackPage(code != null));
    if (!code) return;
    mainWindow?.webContents.send("auth:callback", { code });
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    app.focus({ steal: true });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    authLoopbackServer = null;
    const detail =
      error.code === "EADDRINUSE"
        ? `Sign-in can't complete: port ${AUTH_LOOPBACK_PORT} is already in use. Quit whatever is using it and try again.`
        : `Sign-in callback server failed: ${error.message}`;
    addLog("stderr", detail);
    mainWindow?.webContents.send("auth:callback", { error: detail });
  });
  server.listen({ host: "127.0.0.1", port: AUTH_LOOPBACK_PORT, exclusive: true });
  authLoopbackServer = server;
}

function stopAuthLoopback(): void {
  authLoopbackServer?.close();
  authLoopbackServer = null;
}

function authLoopbackPage(ok: boolean): string {
  const title = ok ? "Signed in to Hitch" : "Hitch sign-in";
  const detail = ok
    ? "You can close this tab and return to Hitch."
    : "No authorization code was found. Return to Hitch and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#101316;color:#e6e8ea;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#9aa3ab;margin:0}</style></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

// Window chrome / launch-flash background per resolved theme. Light is the
// app's --background (white); dark mirrors the renderer's dark --background.
function themeBackground(dark: boolean): string {
  return dark ? "#101316" : "#ffffff";
}

// Drive Electron's nativeTheme from the renderer's Light/Dark/System choice and
// repaint the window background to match, so the native frame and any pre-paint
// background track the chosen theme rather than just the OS.
function setWindowThemeBackground(mode: "light" | "dark" | "system"): void {
  nativeTheme.themeSource = mode;
  const dark =
    mode === "dark" || (mode === "system" && nativeTheme.shouldUseDarkColors);
  mainWindow?.setBackgroundColor(themeBackground(dark));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    title: "Hitch",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    // Match the first frame to the resolved OS theme to avoid a light/dark
    // flash on launch. The renderer pushes the user's stored preference via
    // "theme:set-source" once it loads (see setWindowThemeBackground).
    backgroundColor: themeBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep OAuth out of the embedded window: open the sign-in flow in the system
  // browser (RFC 8252). Cover both will-navigate (the initial location change)
  // and will-redirect (the convex.site -> github.com 302).
  const externalizeSignIn = (event: { preventDefault: () => void }, url: string) => {
    if (!isExternalSignInUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  };
  mainWindow.webContents.on("will-navigate", externalizeSignIn);
  mainWindow.webContents.on("will-redirect", externalizeSignIn);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isExternalSignInUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
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
ipcMain.handle("config:resolve-conflict", (_event, projectId: ProjectId) =>
  resolveProjectConflict(projectId),
);
ipcMain.handle("config:remove-hitch", (_event, projectId: ProjectId) =>
  removeHitch(projectId),
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
ipcMain.handle("integrations:check", () => integrationHealth());
ipcMain.handle("integrations:repair", (_event, id: IntegrationId) =>
  repairIntegration(id),
);
ipcMain.handle("integrations:repair-all", () => repairAllIntegrations());
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
ipcMain.handle("config:get-harness-environments", () =>
  readHarnessEnvironments(),
);
ipcMain.handle(
  "config:set-harness-environment",
  (_event, harness: string, environment: string) =>
    setHarnessEnvironment(harness, environment),
);
ipcMain.handle("config:get-text-generation-model", () =>
  readTextGenerationModel(),
);
ipcMain.handle(
  "config:set-text-generation-model",
  (_event, model: string) => setTextGenerationModel(model),
);
ipcMain.handle("config:get-experimental", () => readExperimentalFlags());
ipcMain.handle(
  "config:set-experimental",
  (_event, key: string, enabled: boolean) => setExperimentalFlag(key, enabled),
);
ipcMain.handle("config:get-starting-prompts", () => readStartingPrompts());
ipcMain.handle("config:set-starting-prompts", (_event, prompts: unknown) =>
  setStartingPrompts(prompts),
);
ipcMain.handle("debug:list-cmux-chats", (_event, projectId: string | null) =>
  callDaemonDebug("listCmuxChats", { projectId: projectId ?? null }),
);
ipcMain.handle("debug:reconcile-cmux", (_event, projectId: string | null) =>
  callDaemonDebug("reconcileCmux", { projectId: projectId ?? null }),
);
ipcMain.handle(
  "debug:read-cmux-trace",
  (
    _event,
    filter: { chatId?: string | null; launchId?: string | null } | undefined,
    limit?: number,
  ) => callDaemonDebug("readCmuxTrace", { filter: filter ?? {}, limit }),
);
ipcMain.handle("cmux:enable-automation", () => enableCmuxAutomation());
ipcMain.handle("cmux:open-app", () => openCmuxApp());
ipcMain.handle("dialog:choose-local-path", (_event, defaultPath?: string) =>
  chooseLocalPath(defaultPath),
);
ipcMain.handle("device-auth:get", () => deviceAuthState());
ipcMain.handle("device-auth:set-token", (_event, token: string) =>
  saveDeviceToken(token),
);
ipcMain.handle("device-auth:clear-token", () => clearDeviceToken());
ipcMain.handle("auth-storage:get", (_event, key: string) => authStorageGet(key));
ipcMain.handle("auth-storage:set", (_event, key: string, value: string) =>
  authStorageSet(key, value),
);
ipcMain.handle("auth-storage:remove", (_event, key: string) =>
  authStorageRemove(key),
);

ipcMain.handle("keep-awake:get-state", () => keepAwakeState());
ipcMain.handle("keep-awake:start", () => startKeepAwake());
ipcMain.handle("keep-awake:stop", () => stopKeepAwake());

ipcMain.handle("theme:set-source", (_event, mode: unknown) => {
  const source =
    mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
  setWindowThemeBackground(source);
});

ipcMain.handle("clipboard:copy-image-from-url", async (_event, url: unknown) => {
  if (typeof url !== "string") throw new Error("Image URL is required");
  const parsed = new URL(url);
  // Renderer fetch already handles ordinary preview loading. This privileged
  // fallback is only for clipboard-write failures, so keep network scope tight.
  if (!["https:", "data:"].includes(parsed.protocol)) {
    throw new Error("Unsupported image URL");
  }
  const res = await fetch(parsed);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const image = nativeImage.createFromBuffer(
    Buffer.from(await res.arrayBuffer()),
  );
  if (image.isEmpty()) throw new Error("Image could not be decoded");
  clipboard.writeImage(image);
});

ipcMain.handle("updater:get-status", () => updaterStatus);
ipcMain.handle("updater:check", async () => {
  // No-op in dev / unconfigured builds: the autoUpdater isn't wired, so there's
  // nothing to check. Return the disabled status for the UI to explain.
  if (!updaterStatus.enabled) return updaterStatus;
  setUpdaterStatus({ phase: "checking", error: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    addLog("stderr", `Update check failed: ${message}`);
    setUpdaterStatus({ phase: "error", error: message });
  }
  return updaterStatus;
});
ipcMain.handle("updater:download", async () => {
  if (!updaterStatus.enabled) return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    addLog("stderr", `Failed to download update: ${message}`);
    setUpdaterStatus({ phase: "error", error: message });
  }
});
ipcMain.handle("updater:install", () => {
  if (!updaterStatus.enabled) return;
  autoUpdater.quitAndInstall(false, true);
});

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
  startAuthLoopback();
  if (readKeepAwakeEnabled()) startKeepAwake(false);
  // Move any legacy config.toml Codex hooks to hooks.json before the daemon can
  // launch Codex, so there's a single hook representation (avoids Codex's
  // dual-loading warning and keeps cmux's hook from colliding).
  migrateCodexHooksRepresentation();
  // Re-install lifecycle hooks left stale by a prior Hitch version so live chat
  // status works on the first post-upgrade launch (drifted-only; never installs
  // for users who never had them — see healDriftedHarnessHooks).
  healDriftedHarnessHooks();
  // If Codex is configured to run in cmux, hand the Codex resume binding to
  // cmux's own hook before the daemon can launch Codex. Other users see this as
  // an available integration in Settings, but we don't silently install it.
  if (effectiveHarnessEnvironments().codex === "cmux") installCmuxCodexHook();
  startDaemon();
  configureAutoUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", (event) => {
  stopAuthLoopback();
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  stopKeepAwake(false);
  if (!daemon || quitAfterDaemonStops) return;
  event.preventDefault();
  quitAfterDaemonStops = true;
  stopDaemon();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
