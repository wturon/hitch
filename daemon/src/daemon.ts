// Hitch daemon runtime: watch projects' local .hitch/ folders and keep them in
// sync with Convex. This module is importable by the CLI, Electron runner, and
// tests; it does not install signal handlers or call process.exit().

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import dotenv from "dotenv";
import chokidar, { type FSWatcher } from "chokidar";
import WebSocket from "ws";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { CmuxError, setCmuxLogger, setCmuxTraceSink } from "./cmux.js";
import { closeCodexAppServer, latestCodexThread } from "./codex.js";
import { openChatLifecycleStore } from "./chatLifecycleStore.js";
import { DaemonLifecycleProducer } from "./chatLifecycleProducers.js";
import { titleFromInitialPrompt } from "./chatTitles.js";
import { closeT3Code, setT3Logger } from "./t3code.js";
import { resolveLauncher } from "./launchers/registry.js";
import {
  LINKED_DOC_KINDS,
  isLinkedDocPath,
  isLinkedDocType,
} from "./linkedDocs.js";
import {
  readClaudeAiTitle,
  stopClaudeSessionLinker,
} from "./launchers/claudeSessionLinker.js";
import type { Environment, Harness } from "./launchers/types.js";
import type { ChatLifecycleStore, LocalChatRow } from "./chatLifecycleStore.js";
import { createDebugApi, type DebugApi } from "./debugApi.js";
import { ChatStateObserver } from "./observer/index.js";
import { startSkillSync } from "./skills.js";
import { frontmatterValue, setFrontmatterKeys } from "./frontmatter.js";
import { runTaskFrontmatterMigration } from "./taskFrontmatterMigration.js";

if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}

export interface HitchBinding {
  projectId: string;
  projectName?: string;
  localPath: string;
  enabled?: boolean;
}

export interface LocalHitchConfig {
  hitches: HitchBinding[];
}

interface ResolvedHitch {
  projectId: string;
  projectName?: string;
  localPath: string;
  hitchPath: string;
}

interface RuntimeConfig {
  hitches: ResolvedHitch[];
}

export interface HitchDaemonLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface HitchDaemonOptions {
  cwd?: string;
  configPath?: string;
  envFiles?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: HitchDaemonLogger;
}

// A folder whose on-disk project.json belongs to a different project than the
// one this environment's config binds it to. Surfaced (not auto-resolved) so the
// desktop UI can offer an explicit "override" — see startHitchBinding.
export interface ProjectConflict {
  projectId: string;
  projectName?: string;
  localPath: string;
  diskProjectId: string;
}

export interface HitchDaemonHandle {
  projectId: string;
  localPath: string;
  hitchPath: string;
  hitches: ResolvedHitch[];
  conflicts: ProjectConflict[];
  // Read-only local debug surface (cmux reconciliation + trace) for the
  // desktop's debug screen. Null when no binding has an open store (all
  // conflicted) — the desktop treats that as "no data".
  debug: DebugApi | null;
  stop: () => Promise<void>;
}

interface FileDoc {
  projectId: string;
  path: string;
  content: string;
  hash: string;
  deleted: boolean;
  updatedAt: number;
}

interface AttachmentDoc {
  projectId: string;
  path: string;
  storageId: string;
  hash: string;
  contentType: string;
  size: number;
  deleted: boolean;
  updatedAt: number;
  // Freshly-signed download URL from listAttachments; null for a tombstone or a
  // GC'd blob.
  url: string | null;
}

interface CommandDoc {
  _id: string;
  projectId: string;
  host?: string;
  kind: string;
  harness: string;
  environment?: string; // unset in release 1; daemon derives from harness default
  launchId?: string;
  automationRunId?: string;
  sessionId?: string;
  path?: string;
  linkedType?: "task" | "note" | "automation";
  linkedPath?: string;
  initialPrompt?: string;
  title?: string;
  cwd?: string;
  model?: string; // start-chat kickoff: model to launch
  effort?: string; // start-chat kickoff: reasoning/effort level
  status: string;
  expiresAt?: number;
  claimedAt?: number;
  claimedBy?: string;
}

type ChatStatus = "working" | "needs-input" | "waiting" | "idle";

export interface PendingChatBindingArgs {
  projectId: string;
  deviceToken: string;
  launchId: string;
  automationRunId?: string;
  harness: Harness;
  chatId: string;
  host: string;
  cwd: string;
  status: ChatStatus;
  environment: Environment;
  resumeKind: "open-chat-command";
  resumePayload: Record<string, never>;
  observedAt: number;
}

export function pendingChatBindingArgs(input: {
  cmd: { launchId?: string; automationRunId?: string };
  projectId: string;
  deviceToken: string;
  harness: Harness;
  chatId: string;
  host: string;
  cwd: string;
  status: ChatStatus;
  environment: Environment;
  observedAt?: number;
}): PendingChatBindingArgs | null {
  if (!input.cmd.launchId) return null;
  return {
    projectId: input.projectId,
    deviceToken: input.deviceToken,
    launchId: input.cmd.launchId,
    ...(input.cmd.automationRunId
      ? { automationRunId: input.cmd.automationRunId }
      : {}),
    harness: input.harness,
    chatId: input.chatId,
    host: input.host,
    cwd: input.cwd,
    status: input.status,
    environment: input.environment,
    resumeKind: "open-chat-command",
    resumePayload: {},
    observedAt: input.observedAt ?? Date.now(),
  };
}

type Unsubscribe = (() => void) | { unsubscribe: () => void };

const defaultLogger: HitchDaemonLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

function deriveConvexUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CONVEX_URL) return env.CONVEX_URL;
  const deployment = env.CONVEX_DEPLOYMENT;
  if (!deployment) return undefined;
  const name = deployment.includes(":")
    ? deployment.split(":")[1]
    : deployment;
  return name ? `https://${name}.convex.cloud` : undefined;
}

function loadEnvFiles(
  cwd: string,
  envFiles: string[],
  env: NodeJS.ProcessEnv,
): void {
  for (const file of envFiles) {
    dotenv.config({
      path: resolve(cwd, file),
      processEnv: env as Record<string, string>,
    });
  }
}

function configError(path: string, message: string): never {
  throw new Error(`Invalid Hitch config at ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appSupportConfigPath(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library/Application Support/Hitch/config.json");
  }
  return join(homedir(), ".config/hitch/config.json");
}

function defaultConfigPath(cwd: string): string {
  const appConfig = appSupportConfigPath();
  return existsSync(appConfig) ? appConfig : resolve(cwd, "hitch.config.json");
}

function resolveMaybeRelative(path: string, base: string): string {
  return resolve(base, path);
}

export function loadHitchConfig(path: string, cwd = process.cwd()): RuntimeConfig {
  if (!existsSync(path)) throw new Error(`No config found at ${path}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    configError(path, `could not read or parse JSON: ${String(err)}`);
  }

  if (!isRecord(parsed)) {
    configError(path, "expected a JSON object at the top level");
  }
  if (!Array.isArray(parsed.hitches)) configError(path, "hitches must be an array");

  const hitches = parsed.hitches
    .map((entry, index): ResolvedHitch | null => {
      if (!isRecord(entry)) configError(path, `hitches[${index}] must be an object`);
      if (entry.enabled === false) return null;

      const projectId =
        typeof entry.projectId === "string" ? entry.projectId.trim() : "";
      const projectName =
        typeof entry.projectName === "string" ? entry.projectName.trim() : undefined;
      const localPath =
        typeof entry.localPath === "string" ? entry.localPath.trim() : "";

      if (!projectId) configError(path, `hitches[${index}].projectId is required`);
      if (!localPath) configError(path, `hitches[${index}].localPath is required`);

      const resolvedLocalPath = resolveMaybeRelative(localPath, cwd);
      return {
        projectId,
        projectName,
        localPath: resolvedLocalPath,
        hitchPath: join(resolvedLocalPath, ".hitch"),
      };
    })
    .filter((entry): entry is ResolvedHitch => entry !== null);

  if (hitches.length === 0) {
    configError(path, "hitches must contain at least one enabled hitch");
  }

  const seenProjects = new Set<string>();
  for (const hitch of hitches) {
    if (seenProjects.has(hitch.projectId)) {
      configError(path, `multiple enabled hitches for project "${hitch.projectId}"`);
    }
    seenProjects.add(hitch.projectId);
  }

  return { hitches };
}

const hashOf = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

// The fire-and-forget "summoning" flag the server stamps on a task/note when a
// delegation is requested (see convex requestDelegation + lib/chat.ts). The
// daemon owns its teardown: it clears these when a real chat binds (the chat-*
// fields take over) and flips them to `failed` when a launch can't be
// provisioned. Kept in sync with the CHAT_REQUEST_* keys in lib/chat.ts.
const CHAT_REQUEST_KEYS = {
  state: "chat-request",
  harness: "chat-request-harness",
  id: "chat-request-id",
  error: "chat-request-error",
} as const;

// Cleared whenever a chat exists on the doc — a bound chat's chat-* fields are
// the source of truth, so the pre-link request flag must not linger beside them.
const CLEAR_CHAT_REQUEST: Record<string, string | undefined> = {
  [CHAT_REQUEST_KEYS.state]: undefined,
  [CHAT_REQUEST_KEYS.harness]: undefined,
  [CHAT_REQUEST_KEYS.id]: undefined,
  [CHAT_REQUEST_KEYS.error]: undefined,
};

// A short, human reason for a failed launch, shown in the card's tooltip. Prefer
// a friendly gloss for the error codes we tag; otherwise squash + truncate the
// raw message so it fits a single frontmatter line.
function delegationFailureReason(result: string, errorCode?: string): string {
  if (errorCode === "cmux-access-denied") return "cmux denied access";
  if (errorCode) return errorCode.replace(/-/g, " ");
  const msg = result.replace(/^Error:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!msg) return "Launch failed";
  return msg.length > 80 ? `${msg.slice(0, 79)}…` : msg;
}

// Files under a task's or note's attachments/ folder are image blobs, NOT UTF-8
// text. They sync via the attachments table (download-only), so the text watcher
// must never read/push them — doing so would shove corrupted binary into the
// `files` table and pollute the cards query. Matches both a file and the dir
// itself, under either primitive's folder.
const ATTACHMENT_RE = /^(?:tasks|notes)\/[^/]+\/attachments(\/|$)/;
// A single attachment file's path, used to scope empty-folder pruning.
const ATTACHMENT_FILE_RE = /^(?:tasks|notes)\/[^/]+\/attachments\/[^/]+$/;

// The canonical body file of each primitive that owns a per-slug folder: a
// task's task.md, a note's index.md, an automation's index.md. When one of
// these is deleted its folder is now empty, so we try to prune the dir behind
// it. Keep automations here so deleting a routine cleans up
// `automations/<slug>/` instead of leaving an empty husk on disk.
const PRUNABLE_BODY_RE =
  /^(?:tasks\/[^/]+\/task\.md|notes\/[^/]+\/index\.md|automations\/[^/]+\/index\.md)$/;

export function isPrunableBodyPath(relPath: string): boolean {
  return PRUNABLE_BODY_RE.test(relPath);
}

const execFileP = promisify(execFile);
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → exists but owned by another
    // user, so still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processCommand(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "command=", "-p", String(pid)]);
    return stdout.trim();
  } catch {
    return "";
  }
}

// Same-machine liveness for the agent process recorded as chat-pid. A coding
// agent stays alive between turns and dies only when the session truly ends, so
// a dead pid is an unambiguous "the chat is over" signal — no timeout needed.
// We also guard against PID reuse: if the live pid is now some unrelated
// process (its command is no longer the harness binary), the agent is gone.
async function isAgentAlive(pid: number, harness: string): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  const command = await processCommand(pid);
  if (!command) return true; // can't verify — don't over-heal a live session
  const needle = harness === "codex" ? "codex" : "claude";
  return command.includes(needle);
}

// A task is in a terminal state once it is completed or archived. Todos v1
// makes the `completed-at:`/`archived-at:` timestamps the sole source of truth;
// the legacy `status: done|archived` read died with the board in slice 6b.
function isTerminalTaskState(content: string): boolean {
  if (frontmatterValue(content, "completed-at")) return true;
  if (frontmatterValue(content, "archived-at")) return true;
  return false;
}

function settledChatStatus(content: string): string | undefined {
  return isTerminalTaskState(content) ? undefined : "waiting";
}

export function projectedChatStatus(
  content: string,
  chat: LocalChatRow,
): string | undefined {
  if (chat.status === "idle") return undefined;
  if (chat.status === "waiting") return settledChatStatus(content);
  return chat.status;
}

// Whether opening this chat's deep link would strand the user. True only for a
// codex thread whose turn Hitch is driving inside its own app-server (non-cmux)
// and that's still mid-turn — the deep link points at the wrong server until the
// turn settles. This is the *sole* meaning of chat-open-state now; the pre-link
// "launch in flight" state it used to double as lives on `chat-request` instead.
function codexOpenPending(chat: LocalChatRow): boolean {
  return (
    chat.harness === "codex" &&
    chat.environment != null &&
    chat.environment !== "cmux" &&
    chat.status === "working"
  );
}

export function projectedChatFrontmatter(
  content: string,
  chat: LocalChatRow,
): Record<string, string | undefined> {
  const status = projectedChatStatus(content, chat);
  const updates: Record<string, string | undefined> = {
    "chat-harness": chat.harness,
    "chat-id": chat.chatId ?? undefined,
    "chat-status": status,
    "chat-open-state": codexOpenPending(chat) ? "pending" : undefined,
    // A projected chat has bound, so any lingering summon flag must go — the
    // chat-* fields are now the truth.
    ...CLEAR_CHAT_REQUEST,
  };

  if (
    chat.harness === "claude-code" ||
    (chat.harness === "codex" && chat.environment === "cmux")
  ) {
    updates["chat-cwd"] = chat.cwd || undefined;
    updates["chat-env"] = chat.environment ?? undefined;
  } else {
    updates["chat-cwd"] = undefined;
    updates["chat-env"] = undefined;
  }

  if (!status) updates["chat-pid"] = undefined;
  return updates;
}

export function frontmatterAlreadyProjected(
  content: string,
  updates: Record<string, string | undefined>,
): boolean {
  for (const [key, value] of Object.entries(updates)) {
    const current = frontmatterValue(content, key);
    if ((current ?? undefined) !== value) return false;
  }
  return true;
}

function unsubscribe(subscription: Unsubscribe): void {
  if (typeof subscription === "function") {
    subscription();
    return;
  }
  subscription.unsubscribe();
}

function logError(logger: HitchDaemonLogger, message: string): void {
  (logger.error ?? logger.info)(message);
}

interface HitchBindingRuntimeOptions {
  client: ConvexClient;
  env: NodeJS.ProcessEnv;
  deviceToken: string;
  hitch: ResolvedHitch;
  logger: HitchDaemonLogger;
  host: string;
  configPath: string;
}

// Per-harness environment preference, written by the desktop app into a sibling
// preferences.json (kept out of config.json so the hitches normalizer can't wipe
// it). Read fresh per command so a change in Harness settings takes effect without
// restarting the daemon. Absent/invalid → undefined, so the registry falls back to
// the harness default and behavior is unchanged.
function readHarnessEnvironment(
  configPath: string,
  harness: Harness,
): Environment | undefined {
  try {
    const prefsPath = join(dirname(configPath), "preferences.json");
    const raw = JSON.parse(readFileSync(prefsPath, "utf8")) as unknown;
    if (!isRecord(raw) || !isRecord(raw.harnessEnvironments)) return undefined;
    const value = raw.harnessEnvironments[harness];
    return (
      value === "cmux" ||
      value === "codex-app" ||
      value === "vscode" ||
      value === "cursor"
    )
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

const PROJECT_CONFIG_FILENAME = "project.json";

// Read the projectId baked into a folder's .hitch/project.json. Returns null for
// a missing or unparseable file — those are not conflicts (a fresh hitch has no
// project.json yet; a garbled one is left for normal sync to overwrite). Only a
// well-formed file whose projectId differs from the binding is a conflict.
function readDiskProjectId(hitchPath: string): string | null {
  try {
    const raw = readFileSync(join(hitchPath, PROJECT_CONFIG_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    return typeof parsed.projectId === "string" && parsed.projectId.trim()
      ? parsed.projectId.trim()
      : null;
  } catch {
    return null;
  }
}

interface HitchBindingHandle {
  stop: () => Promise<void>;
  // Set when this folder's project.json belongs to a different project, in which
  // case the binding does NOT sync (no subscription, no push) until resolved.
  conflict?: ProjectConflict;
  // The binding's local store, surfaced so startHitchDaemon can build the debug
  // API over it. Absent on a conflicted binding (it never opens one).
  chatLifecycleStore?: ChatLifecycleStore;
}

async function startHitchBinding({
  client,
  env,
  deviceToken,
  hitch: root,
  logger,
  host,
  configPath,
}: HitchBindingRuntimeOptions): Promise<HitchBindingHandle> {
  const projectId = root.projectId;
  const projectLabel = root.projectName || projectId;
  mkdirSync(root.hitchPath, { recursive: true });

  // Cross-environment guard: if the folder's project.json carries a different
  // projectId (e.g. it was last synced against another Convex deployment),
  // refuse to sync this binding so we never push a foreign project.json up or
  // pull the wrong project's files down. Surface the conflict for the UI to
  // resolve with an explicit override, then the daemon restarts and re-checks.
  const diskProjectId = readDiskProjectId(root.hitchPath);
  if (diskProjectId && diskProjectId !== projectId) {
    logError(
      logger,
      `[hitch:${projectLabel}] project.json belongs to ${diskProjectId}, not ${projectId} — skipping sync until resolved`,
    );
    return {
      stop: async () => {},
      conflict: {
        projectId,
        projectName: root.projectName,
        localPath: root.localPath,
        diskProjectId,
      },
    };
  }

  setT3Logger(logger);
  setCmuxLogger(logger);

  const lastHash = new Map<string, string>();
  const subscriptions: Unsubscribe[] = [];
  const chatLifecycleStore = openChatLifecycleStore({ env });
  // Persist the structured cmux trace into the same local store the harness
  // hooks write to (a sibling table, never synced to Convex). Wired here rather
  // than at setCmuxLogger above because the store isn't open until now.
  setCmuxTraceSink((event) => chatLifecycleStore.appendCmuxTrace(event));
  const lifecycleProducer = new DaemonLifecycleProducer({
    store: chatLifecycleStore,
    projectId,
    projectLocalPath: root.localPath,
    host,
  });

  function emitLifecycle(
    emit: () => { inserted: boolean; seq: number | null },
    label: string,
  ): void {
    try {
      emit();
    } catch (err) {
      logError(
        logger,
        `[hitch:${projectLabel}] failed to record chat lifecycle event (${label}): ${String(err)}`,
      );
    }
  }

  async function syncReducedChats(): Promise<number> {
    const dirtyChats = chatLifecycleStore.listDirtyChats(100);
    let synced = 0;
    for (const chat of dirtyChats) {
      if (!chat.projectId) continue;
      const convexId = (await client.mutation(anyApi.chats.upsertReducedState, {
        projectId: chat.projectId,
        deviceToken,
        launchId: chat.launchId ?? undefined,
        automationRunId:
          typeof chat.resumePayload.automationRunId === "string"
            ? chat.resumePayload.automationRunId
            : undefined,
        harness: chat.harness,
        chatId: chat.chatId ?? undefined,
        pending: chat.pending,
        status: chat.status,
        title: chat.title,
        cwd: chat.cwd,
        host: chat.host,
        environment: chat.environment ?? undefined,
        linkedType: chat.linkedType ?? undefined,
        linkedPath: chat.linkedPath ?? undefined,
        resumeKind: chat.resumeKind,
        resumePayload: chat.resumePayload,
        observedStatus: chat.observedStatus ?? undefined,
        observedExistence: chat.observedExistence ?? undefined,
        observedActivity: chat.observedActivity ?? undefined,
        observedSource: chat.observedSource ?? undefined,
        observedAt: chat.observedAt ?? undefined,
        firstObservedAt: chat.firstObservedAt,
        lastEventAt: chat.lastEventAt,
        lastStatusAt: chat.lastStatusAt,
        endedAt: chat.endedAt ?? undefined,
      })) as string;
      chatLifecycleStore.markChatSynced(chat.localKey, { convexId });
      synced += 1;
    }
    return synced;
  }

  async function projectReducedFileFrontmatter(): Promise<number> {
    let projected = 0;
    const chats = chatLifecycleStore.listFileLinkedChats(projectId);
    for (const chat of chats) {
      const linkedPath = chat.linkedPath;
      // Only the canonical doc bodies carry chat frontmatter (task.md/index.md).
      if (!linkedPath || !isLinkedDocPath(linkedPath)) continue;
      // Don't project an unbound chat (no chatId yet — e.g. the codex ID-gap
      // launch row). The doc's launch state is owned by `chat-request` until a
      // real session binds; projecting a half-row here would fight that flag and
      // resurrect the pre-link/openability conflation we just untangled.
      if (!chat.chatId) continue;

      const absPath = toAbs(linkedPath);
      let content: string;
      try {
        content = await readFile(absPath, "utf8");
      } catch {
        continue;
      }

      const updates = projectedChatFrontmatter(content, chat);
      if (frontmatterAlreadyProjected(content, updates)) continue;

      try {
        await writeFile(absPath, setFrontmatterKeys(content, updates), "utf8");
        projected += 1;
        logger.info(
          `[hitch:${projectLabel}] projected chat ${chat.chatId ?? chat.launchId ?? chat.localKey} → ${linkedPath}`,
        );
      } catch (err) {
        logError(
          logger,
          `[hitch:${projectLabel}] failed to project chat ${chat.localKey} to ${linkedPath}: ${String(err)}`,
        );
      }
    }
    return projected;
  }

  async function refreshCodexThreadTitles(): Promise<number> {
    const chats = chatLifecycleStore.listChatsForTitleRefresh(projectId, "codex");
    const results = await Promise.all(
      chats.map(async (chat) => {
        if (!chat.chatId) return false;
        const snapshot = await latestCodexThread(chat.chatId).catch((err) => {
          logError(
            logger,
            `[hitch:${projectLabel}] failed to read Codex thread title for ${chat.chatId}: ${String(err)}`,
          );
          return null;
        });
        const title = snapshot?.title?.trim();
        if (!title) return false;
        return chatLifecycleStore.updateChatTitle(chat.localKey, title);
      }),
    );
    return results.filter(Boolean).length;
  }

  // Claude Code owns its own naming: a small model writes the session title into
  // the transcript on the first turn. We read it back rather than imposing one,
  // so the launch placeholder (task title / first prompt) gives way to Claude's
  // generated title once it lands. Mirrors refreshCodexThreadTitles, but reads
  // the transcript on disk instead of querying an app-server.
  function refreshClaudeChatTitles(): number {
    const chats = chatLifecycleStore.listChatsForTitleRefresh(
      projectId,
      "claude-code",
    );
    let changed = 0;
    for (const chat of chats) {
      if (!chat.chatId) continue;
      const title = readClaudeAiTitle(chat.cwd, chat.chatId);
      if (!title) continue;
      if (chatLifecycleStore.updateChatTitle(chat.localKey, title)) changed += 1;
    }
    return changed;
  }

  let reducing = false;
  let reduceAgain = false;
  async function reduceAndSyncChats(reason: string): Promise<void> {
    if (reducing) {
      reduceAgain = true;
      return;
    }
    reducing = true;
    try {
      do {
        reduceAgain = false;
        let totalReduced = 0;
        let totalChanged = 0;
        let totalFailed = 0;
        for (;;) {
          const result = chatLifecycleStore.reduceLifecycleEvents();
          totalReduced += result.eventsReduced;
          totalChanged += result.chatsChanged;
          totalFailed += result.failed;
          if (result.eventsReduced < 100) break;
        }
        if (totalFailed > 0) {
          // A quarantined event means a chat may not have bound/linked. The
          // reducer no longer wedges on it (it advanced past), but this must be
          // loud — the swallowed catch below is a last resort, not the signal.
          logError(
            logger,
            `[hitch:${projectLabel}] quarantined ${totalFailed} un-reducible chat event(s) (${reason}) — see chat_events.reduce_error`,
          );
        }
        const isDelayedTitleRefresh = reason.startsWith("title-refresh");
        const titlesRefreshed =
          totalReduced > 0 || isDelayedTitleRefresh
            ? (await refreshCodexThreadTitles()) + refreshClaudeChatTitles()
            : 0;
        const synced = await syncReducedChats();
        const projected = await projectReducedFileFrontmatter();
        if (totalReduced > 0 || titlesRefreshed > 0 || synced > 0 || projected > 0) {
          chatLifecycleStore.cleanupReducedEvents();
          chatLifecycleStore.pruneCmuxTrace();
          logger.info(
            `[hitch:${projectLabel}] reduced ${totalReduced} chat event(s), changed ${totalChanged} chat(s), refreshed ${titlesRefreshed} title(s), synced ${synced} chat(s), projected ${projected} doc(s) (${reason})`,
          );
        }
        if (totalReduced > 0 && !isDelayedTitleRefresh) {
          scheduleTitleRefresh(reason);
        }
      } while (reduceAgain);
    } catch (err) {
      logError(
        logger,
        `[hitch:${projectLabel}] chat lifecycle reduce/sync failed (${reason}): ${String(err)}`,
      );
    } finally {
      reducing = false;
    }
  }

  let titleRefreshTimer: NodeJS.Timeout | undefined;
  function scheduleTitleRefresh(reason: string): void {
    if (titleRefreshTimer) clearTimeout(titleRefreshTimer);
    titleRefreshTimer = setTimeout(() => {
      titleRefreshTimer = undefined;
      void reduceAndSyncChats(`title-refresh:${reason}`);
    }, 5_000);
  }

  let reduceDebounce: NodeJS.Timeout | undefined;
  function scheduleReduce(reason: string): void {
    if (reduceDebounce) clearTimeout(reduceDebounce);
    reduceDebounce = setTimeout(() => {
      reduceDebounce = undefined;
      void reduceAndSyncChats(reason);
    }, 100);
  }

  void reduceAndSyncChats("startup");
  const chatReducePollTimer = setInterval(
    () => void reduceAndSyncChats("poll"),
    2_000,
  );
  const chatBumpName = basename(chatLifecycleStore.paths.bumpPath);
  function isChatBumpPath(path: string): boolean {
    return basename(path) === chatBumpName;
  }
  // The bump file lives in Electron's user-data dir, which Chromium fills with
  // cache trees (~10k files). An unscoped recursive watch opens one fd per
  // file on macOS, and past ~10240 open fds every child spawn in this process
  // fails with EBADF — which took down all cmux launches. Watch shallowly and
  // ignore everything but the bump file.
  const chatBumpDir = dirname(chatLifecycleStore.paths.bumpPath);
  const chatBumpWatcher = chokidar.watch(chatBumpDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    depth: 0,
    ignored: (path) => path !== chatBumpDir && !isChatBumpPath(path),
  });
  chatBumpWatcher
    .on("add", (path) => {
      if (isChatBumpPath(path)) scheduleReduce("bump");
    })
    .on("change", (path) => {
      if (isChatBumpPath(path)) scheduleReduce("bump");
    })
    .on("error", (err) =>
      logError(logger, `[hitch:${projectLabel}] chat bump watcher failed: ${err}`),
    );

  function locate(absPath: string): { rel: string } | null {
    const rel = relative(root.hitchPath, absPath);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) {
      return { rel: rel.split(sep).join("/") };
    }
    return null;
  }

  function toAbs(rel: string): string {
    return join(root.hitchPath, rel.split("/").join(sep));
  }

  async function linkCodexThread(
    path: string,
    threadId: string,
    cwd: string,
    environment: Environment,
  ) {
    const absPath = toAbs(path);
    const current = await readFile(absPath, "utf8");
    const next = setFrontmatterKeys(current, {
      "chat-harness": "codex",
      "chat-id": threadId,
      "chat-cwd": environment === "cmux" ? cwd : undefined,
      "chat-env": environment === "cmux" ? environment : undefined,
      "chat-open-state": environment === "cmux" ? undefined : "pending",
      // The summon flag has served its purpose — this doc now has a real chat.
      ...CLEAR_CHAT_REQUEST,
    });
    await writeFile(absPath, next, "utf8");
    logger.info(`[hitch:${projectLabel}] linked codex thread ${threadId} → ${path}`);
  }

  async function linkClaudeSession(
    path: string,
    sessionId: string,
    cwd: string,
    environment: Environment,
  ) {
    const absPath = toAbs(path);
    const current = await readFile(absPath, "utf8");
    // Pin the session id (cmux passes it to `claude --session-id`) or bind a
    // discovered id (vscode/cursor). chat-env records which environment owns the
    // session so the daemon's pid-healing knows whether to apply.
    const next = setFrontmatterKeys(current, {
      "chat-harness": "claude-code",
      "chat-id": sessionId,
      "chat-cwd": cwd,
      "chat-env": environment,
      // The summon flag has served its purpose — this doc now has a real chat.
      ...CLEAR_CHAT_REQUEST,
    });
    await writeFile(absPath, next, "utf8");
    logger.info(`[hitch:${projectLabel}] linked claude session ${sessionId} → ${path}`);
  }

  async function bindPendingChat(
    cmd: CommandDoc,
    harness: Harness,
    sessionId: string,
    cwd: string,
    environment: Environment,
  ): Promise<void> {
    const args = pendingChatBindingArgs({
      cmd,
      projectId,
      deviceToken,
      harness,
      chatId: sessionId,
      host,
      cwd,
      status: "working",
      environment,
    });
    if (args) {
      await client.mutation(anyApi.chats.bindPendingChat, args);
    }
    await reduceAndSyncChats("chat-bound");
  }

  async function settlePendingChat(
    cmd: CommandDoc,
    harness: Harness,
    sessionId: string,
    cwd: string,
    environment: Environment,
  ): Promise<void> {
    const args = pendingChatBindingArgs({
      cmd,
      projectId,
      deviceToken,
      harness,
      chatId: sessionId,
      host,
      cwd,
      status: "waiting",
      environment,
    });
    if (args) {
      await client.mutation(anyApi.chats.bindPendingChat, args);
    }
    await reduceAndSyncChats("chat-settled");
  }

  // The task doc a start-chat command targets, or null if it isn't a
  // task-linked start-chat. Only tasks carry the card-visible `chat-request`
  // flag today (notes are handled by their own dock), so the flag lifecycle is
  // scoped to them.
  function taskDocForCommand(cmd: CommandDoc): string | null {
    if (cmd.kind !== "start-chat") return null;
    const linkedType = cmd.linkedType ?? (cmd.path ? "task" : undefined);
    const linkedPath = cmd.linkedPath ?? cmd.path;
    if (linkedType !== "task" || !linkedPath) return null;
    return linkedPath;
  }

  // The launch this command belongs to still owns the doc's request flag — i.e.
  // the user hasn't Cleared + re-fired a newer launch since. Compared against the
  // doc's chat-request-id so a stale command's late resolution can't clobber a
  // fresher request (review #5). A doc with no id yet (the file write lost the
  // claim round-trip — review #4) is treated as ours, since only our launch is
  // in flight for this path at claim time.
  function stillOwnsRequest(cmd: CommandDoc, content: string): boolean {
    const docLaunch = frontmatterValue(content, CHAT_REQUEST_KEYS.id);
    if (!docLaunch || !cmd.launchId) return true;
    return docLaunch === cmd.launchId;
  }

  // A doc-linked launch failed before any session bound (cmux gone, harness
  // misconfigured, unsupported environment). Flip the summon flag to `failed` so
  // the failure lands durably on the card instead of vanishing with the closed
  // dialog. Guarded so it can't clobber a chat that bound or a newer request; it
  // does NOT require the `requested` flag to be on disk yet, so a fast failure
  // that outran the file→disk write still lands (review #4) — the flag it writes
  // simply wins the later, staler `requested` echo by recency.
  async function markDelegationFailed(
    cmd: CommandDoc,
    reason: string,
  ): Promise<void> {
    const linkedPath = taskDocForCommand(cmd);
    if (!linkedPath) return;
    const absPath = toAbs(linkedPath);
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    if (frontmatterValue(content, "chat-id")) return;
    if (!stillOwnsRequest(cmd, content)) return;
    const next = setFrontmatterKeys(content, {
      [CHAT_REQUEST_KEYS.state]: "failed",
      // Restore harness/id in case the file write hadn't landed them yet, so the
      // card can still draw the chip and future resolutions correlate correctly.
      [CHAT_REQUEST_KEYS.harness]:
        frontmatterValue(content, CHAT_REQUEST_KEYS.harness) ?? cmd.harness,
      [CHAT_REQUEST_KEYS.id]:
        frontmatterValue(content, CHAT_REQUEST_KEYS.id) ?? cmd.launchId,
      [CHAT_REQUEST_KEYS.error]: reason,
    });
    if (next === content) return;
    try {
      await writeFile(absPath, next, "utf8");
      await pushLocal(absPath);
      logger.info(
        `[hitch:${projectLabel}] ⚑ delegation failed → ${linkedPath}: ${reason}`,
      );
    } catch (err) {
      logError(
        logger,
        `[hitch:${projectLabel}] failed to stamp delegation failure on ${linkedPath}: ${String(err)}`,
      );
    }
  }

  // A launch reported success but bound no session in-band — the editor
  // launchers (Claude in VS Code / Cursor) open a pre-filled prompt and return
  // `done` immediately; the session only binds later, when the user presses Enter
  // and claudeSessionLinker fires (review #2). Nothing else clears the summon
  // flag in that window, so it would sit at "Summoning…" forever. Resolve it on
  // the successful completion: drop the flag back to the compose state (the card
  // then reflects the real chat once the linker binds). Guarded to our own
  // still-outstanding request so it can't wipe a bound chat or a newer launch.
  async function clearDelegationOnSuccess(cmd: CommandDoc): Promise<void> {
    const linkedPath = taskDocForCommand(cmd);
    if (!linkedPath) return;
    const absPath = toAbs(linkedPath);
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    if (frontmatterValue(content, "chat-id")) return; // already bound → its own teardown ran
    if (!frontmatterValue(content, CHAT_REQUEST_KEYS.state)) return;
    if (!stillOwnsRequest(cmd, content)) return;
    const next = setFrontmatterKeys(content, CLEAR_CHAT_REQUEST);
    if (next === content) return;
    try {
      await writeFile(absPath, next, "utf8");
      await pushLocal(absPath);
    } catch (err) {
      logError(
        logger,
        `[hitch:${projectLabel}] failed to clear delegation flag on ${linkedPath}: ${String(err)}`,
      );
    }
  }

  async function pushLocal(absPath: string): Promise<void> {
    const loc = locate(absPath);
    if (!loc) return;
    // Never read attachment blobs as UTF-8 or push them into `files` — they sync
    // download-only via the attachments table.
    if (ATTACHMENT_RE.test(loc.rel)) return;
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    const hash = hashOf(content);
    if (lastHash.get(absPath) === hash) return;
    lastHash.set(absPath, hash);
    await client.mutation(anyApi.files.upsertFile, {
      projectId,
      deviceToken,
      path: loc.rel,
      content,
      hash,
      deleted: false,
    });
    logger.info(`[hitch:${projectLabel}] ↑ ${loc.rel}`);
  }

  async function pushDelete(absPath: string): Promise<void> {
    const loc = locate(absPath);
    if (!loc) return;
    // Attachment deletes are driven by the attachments table, not the watcher.
    if (ATTACHMENT_RE.test(loc.rel)) return;
    lastHash.delete(absPath);
    await client.mutation(anyApi.files.upsertFile, {
      projectId,
      deviceToken,
      path: loc.rel,
      content: "",
      hash: "",
      deleted: true,
    });
    logger.info(`[hitch:${projectLabel}] ✗ ${loc.rel}`);
    await pruneEmptyTaskDir(loc.rel, absPath);
  }

  // Remove the now-empty folder left behind when a task's task.md, a note's
  // index.md, or an automation's index.md is deleted. rmdir fails on a non-empty
  // dir — that's the signal to stop, not an error.
  async function pruneEmptyTaskDir(relPath: string, absPath: string): Promise<void> {
    if (!isPrunableBodyPath(relPath)) return;

    try {
      await rmdir(dirname(absPath));
      logger.info(`[hitch:${projectLabel}] ↓✗ ${dirname(relPath)}/`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
      logError(
        logger,
        `[hitch:${projectLabel}] directory cleanup failed for ${dirname(relPath)}: ${String(err)}`,
      );
    }
  }

  subscriptions.push(
    client.onUpdate(
      anyApi.files.listFiles,
      { projectId, deviceToken },
      async (files: FileDoc[]) => {
        for (const f of files) {
          const absPath = toAbs(f.path);

          // Apply each file independently: a single unwritable file (e.g. a
          // path component over the OS limit → ENAMETOOLONG) must log and be
          // skipped, never throw out of the callback and crash the daemon.
          try {
            if (f.deleted) {
              if (existsSync(absPath)) {
                lastHash.delete(absPath);
                await rm(absPath, { force: true });
                logger.info(`[hitch:${projectLabel}] ↓✗ ${f.path}`);
              }
              await pruneEmptyTaskDir(f.path, absPath);
              continue;
            }

            const contentHash = hashOf(f.content);
            if (lastHash.get(absPath) === contentHash) continue;
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, f.content, "utf8");
            // Mark synced only after a successful write, so a transient failure
            // is retried on the next update rather than silently masked.
            lastHash.set(absPath, contentHash);
            logger.info(`[hitch:${projectLabel}] ↓ ${f.path}`);
          } catch (err) {
            logError(
              logger,
              `[hitch:${projectLabel}] failed to apply ${f.path}: ${String(err)}`,
            );
          }
        }
      },
      (err) =>
        logError(logger, `[hitch:${projectLabel}] files subscription failed: ${String(err)}`),
    ),
  );

  // Todos v1 (slice 6a): one-time frontmatter migration rewriting legacy
  // `status:` into `completed-at:`/`archived-at:` timestamps. Runs once per
  // project (gated by a synced `todosSchemaVersion` marker in project.json),
  // here — after the files subscription is attached — so each rewrite pushes up
  // through the normal path (pushLocal → Convex → other machines). Non-fatal to
  // startup: a failure logs and leaves the marker unwritten, so the intrinsically
  // idempotent walk simply resumes next boot. See PRD §4 "Migration mechanics".
  void runTaskFrontmatterMigration({
    hitchPath: root.hitchPath,
    pushLocal,
    logger: {
      info: (message) => logger.info(`[hitch:${projectLabel}] ${message}`),
      error: (message) => logError(logger, `[hitch:${projectLabel}] ${message}`),
    },
  }).catch((err) =>
    logError(
      logger,
      `[hitch:${projectLabel}] task frontmatter migration failed: ${String(err)}`,
    ),
  );

  // Attachment hashes we've materialized locally, keyed by abs path — lets us
  // skip re-downloading a blob whose bytes already match.
  const attachmentHash = new Map<string, string>();

  // After removing an attachment file, drop the now-empty attachments/ folder
  // (and the task folder, if that too is now empty) so the local .hitch doesn't
  // accumulate orphan directories. rmdir fails on a non-empty dir — that's the
  // signal to stop, not an error.
  async function pruneEmptyAttachmentDir(
    relPath: string,
    absPath: string,
  ): Promise<void> {
    if (!ATTACHMENT_FILE_RE.test(relPath)) return;
    const attDir = dirname(absPath); // tasks/<slug>/attachments
    const taskDir = dirname(attDir); // tasks/<slug>
    for (const dir of [attDir, taskDir]) {
      try {
        await rmdir(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") {
          return;
        }
        logError(
          logger,
          `[hitch:${projectLabel}] attachment dir cleanup failed for ${dir}: ${String(err)}`,
        );
        return;
      }
    }
  }

  // Download-only materialization of image attachments: Convex storage → local
  // disk. No upload direction in v1 (the renderer is the sole ingress), which
  // sidesteps any re-upload echo loop. A tombstone removes the local file.
  subscriptions.push(
    client.onUpdate(
      anyApi.attachments.listAttachments,
      { projectId, deviceToken },
      async (rows: AttachmentDoc[]) => {
        for (const a of rows) {
          const absPath = toAbs(a.path);

          if (a.deleted) {
            if (existsSync(absPath)) {
              attachmentHash.delete(absPath);
              await rm(absPath, { force: true });
              logger.info(`[hitch:${projectLabel}] ↓✗ ${a.path}`);
            }
            await pruneEmptyAttachmentDir(a.path, absPath);
            continue;
          }

          if (attachmentHash.get(absPath) === a.hash && existsSync(absPath)) {
            continue;
          }
          if (!a.url) continue; // blob GC'd or not yet uploaded — nothing to pull
          try {
            const res = await fetch(a.url);
            if (!res.ok) {
              logError(
                logger,
                `[hitch:${projectLabel}] attachment download failed (${res.status}) for ${a.path}`,
              );
              continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, buf);
            attachmentHash.set(absPath, a.hash);
            logger.info(`[hitch:${projectLabel}] ↓ ${a.path}`);
          } catch (err) {
            logError(
              logger,
              `[hitch:${projectLabel}] attachment download failed for ${a.path}: ${String(err)}`,
            );
          }
        }
      },
      (err) =>
        logError(
          logger,
          `[hitch:${projectLabel}] attachments subscription failed: ${String(err)}`,
        ),
    ),
  );

  async function sendHeartbeat(): Promise<void> {
    try {
      await client.mutation(anyApi.status.heartbeat, {
        projectId,
        deviceToken,
        hostname: host,
      });
    } catch {
      // transient — the next tick will retry
    }
  }

  void sendHeartbeat();
  const heartbeatTimer = setInterval(() => void sendHeartbeat(), 15_000);

  // Heal stale chat-status without fighting the hooks. Claude Code gets a
  // per-session pid, so pid death clears stale working/waiting. Codex status is
  // hook/app-server driven; polling durable turn history can see the previous
  // completed turn during a live resumed turn, so don't reconcile Codex here.
  async function reconcileChatStatus(): Promise<void> {
    // Every linked doc kind (tasks/task.md, notes/index.md) stamps a chat-status,
    // so a dead cmux Claude process on any must be reconciled or it hangs in
    // "working". Walk each kind's dir from the shared LINKED_DOC_KINDS list.
    for (const kind of LINKED_DOC_KINDS) {
      await reconcileChatStatusInDir(kind.dir, kind.file);
    }
  }

  async function reconcileChatStatusInDir(
    dir: string,
    filename: string,
  ): Promise<void> {
    const baseDir = join(root.hitchPath, dir);
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const linkedPath = `${dir}/${entry.name}/${filename}`;
      const absPath = join(baseDir, entry.name, filename);
      let content: string;
      try {
        content = await readFile(absPath, "utf8");
      } catch {
        continue;
      }
      const status = frontmatterValue(content, "chat-status");
      // "needs-input" is a live, mid-turn state too: a card stuck on a
      // permission prompt whose terminal then closed must still get pid-healed.
      if (
        status !== "working" &&
        status !== "waiting" &&
        status !== "needs-input"
      ) {
        continue;
      }
      const harness = frontmatterValue(content, "chat-harness") ?? "";

      // T3Code is hard-blocked; leave old task metadata untouched and do not
      // poll T3Code's local API / CDP path in the background.
      if (frontmatterValue(content, "chat-env") === "t3code") {
        continue;
      }

      if (harness === "claude-code") {
        // pid-healing only applies to process-lifecycle environments (cmux): a dead
        // claude pid means the chat is over. Hook-lifecycle envs (vscode/cursor) run
        // the agent under the editor's process — chat-pid isn't a `claude` process,
        // so healing on it would wrongly clear a live session. Those envs settle via
        // the Stop/SessionEnd hooks instead, so skip them here.
        const env = frontmatterValue(content, "chat-env") as Environment | undefined;
        const launcher = resolveLauncher("claude-code", env);
        if (launcher && launcher.traits.lifecycle !== "process") continue;

        const pidRaw = frontmatterValue(content, "chat-pid");
        const pid = pidRaw ? Number(pidRaw) : NaN;
        // No usable pid yet (freshly linked, before the first hook) → leave it
        // to the hooks rather than risk clearing a session that's just booting.
        if (!Number.isInteger(pid) || pid <= 1) continue;
        if (await isAgentAlive(pid, harness)) continue;
        const chatId = frontmatterValue(content, "chat-id");
        if (chatId) {
          emitLifecycle(
            () =>
              lifecycleProducer.sessionEnded({
                harness: "claude-code",
                environment: env ?? null,
                cwd: frontmatterValue(content, "chat-cwd") ?? root.localPath,
                linkedPath,
                chatId,
                pid,
              }),
            `claude ended ${chatId}`,
          );
        }

        logger.info(
          `[hitch:${projectLabel}] recorded ended claude session (pid ${pid} gone) → ${linkedPath}`,
        );
        continue;
      }
    }
  }

  void reconcileChatStatus();
  const reconcileTimer = setInterval(
    () => void reconcileChatStatus().catch(() => {}),
    15_000,
  );

  const handledCommands = new Set<string>();

  async function complete(
    cmd: CommandDoc,
    status: "done" | "error",
    result: string,
    errorCode?: string,
  ): Promise<void> {
    await client.mutation(anyApi.commands.completeCommand, {
      id: cmd._id,
      status,
      result,
      errorCode,
      projectId,
      deviceToken,
      claimedBy: host,
    });
    // Every completion for a doc-linked launch flows through here, so this is the
    // one place the summon flag has to resolve. On error → `failed` (card-visible
    // + retryable). On a success that bound no session in-band (editor launchers
    // return `done` before the user submits) → clear it so it doesn't stick at
    // "Summoning…". Both no-op for non-task / already-bound docs.
    if (status === "error") {
      await markDelegationFailed(cmd, delegationFailureReason(result, errorCode));
    } else {
      await clearDelegationOnSuccess(cmd);
    }
  }

  async function claimCommand(cmd: CommandDoc): Promise<CommandDoc | null> {
    return await client.mutation(anyApi.commands.claimCommand, {
      id: cmd._id,
      projectId,
      deviceToken,
      claimedBy: host,
    });
  }

  // Orchestrate a launch command: resolve the (harness, environment) launcher and
  // invoke the requested intent. The launchers wrap the same cmux.ts / codex.ts
  // code the switch used to call inline, so behavior is unchanged; this just makes
  // environment a first-class dispatch axis. Linking stays here (it writes the
  // binding's task files) and is handed to startNew as harness-appropriate
  // callbacks — codex only learns its thread id mid-launch, so it can't be hoisted.
  async function runCommand(cmd: CommandDoc): Promise<void> {
    try {
      const harness = cmd.harness as Harness;
      if (cmd.environment === "t3code") {
        await complete(
          cmd,
          "error",
          "T3Code integration is blocked until programmatic chat focusing is enabled by the maintainers",
        );
        return;
      }
      const environment =
        (cmd.environment as Environment | undefined) ??
        readHarnessEnvironment(configPath, harness);
      if (environment === "t3code") {
        await complete(
          cmd,
          "error",
          "T3Code integration is blocked until programmatic chat focusing is enabled by the maintainers",
        );
        return;
      }
      const launcher = resolveLauncher(harness, environment);
      if (!launcher) {
        await complete(
          cmd,
          "error",
          `unsupported harness/environment: ${cmd.harness}/${cmd.environment ?? "default"}`,
        );
        return;
      }
      const project = { projectId, projectName: projectLabel };

      if (cmd.kind === "open-chat") {
        if (!launcher.reopen) {
          throw new Error(`reopen not supported for ${cmd.harness}`);
        }
        const sessionId = cmd.sessionId ?? "";
        const { result } = await launcher.reopen({
          sessionId,
          cwd: cmd.cwd,
          project,
        });
        await complete(cmd, "done", result);
        logger.info(`[hitch:${projectLabel}] ⮑ open-chat ${sessionId} → ${result}`);
      } else if (cmd.kind === "close-chat") {
        if (!launcher.close) {
          throw new Error(
            `close not supported for ${cmd.harness}/${launcher.environment}`,
          );
        }
        if (!cmd.sessionId) throw new Error("close-chat requires sessionId");
        const { result } = await launcher.close({
          sessionId: cmd.sessionId,
          project,
        });
        await complete(cmd, "done", result);
        logger.info(
          `[hitch:${projectLabel}] ⮑ close-chat ${cmd.sessionId} → ${result}`,
        );
      } else if (cmd.kind === "start-chat") {
        if (!launcher.startNew) {
          throw new Error(`start-chat not supported for ${cmd.harness}`);
        }
        if (!cmd.initialPrompt) throw new Error("start-chat requires initialPrompt");
        const linkedType = cmd.linkedType ?? (cmd.path ? "task" : undefined);
        const linkedPath = cmd.linkedPath ?? cmd.path;
        // A start-chat must be keyable: either a linked doc/path or a launchId.
        if (linkedPath === undefined && !cmd.launchId) {
          throw new Error("start-chat requires linkedPath or launchId");
        }
        // Tasks AND notes carry their on-disk location in linkedPath and want
        // their linked file (task.md / index.md) stamped with chat metadata on
        // bind — and projected / pid-healed below. Automations link a path too
        // but aren't editable docs, so they keep the old "not stamped" behavior.
        const stampsLinkedFile =
          linkedPath !== undefined && isLinkedDocType(linkedType);
        const launchKey = linkedPath ?? cmd.launchId ?? cmd._id;
        const launchCwd = cmd.cwd ?? root.localPath;
        const title = cmd.title ?? titleFromInitialPrompt(cmd.initialPrompt, harness);
        emitLifecycle(
          () =>
            lifecycleProducer.chatCreated({
              commandId: cmd._id,
              launchId: cmd.launchId ?? null,
              automationRunId: cmd.automationRunId ?? null,
              harness,
              environment: launcher.environment,
              cwd: launchCwd,
              linkedPath: linkedPath ?? null,
              title,
            }),
          `start-chat ${cmd.launchId ?? cmd._id}`,
        );
        const onLinked =
          harness === "codex"
            ? async (threadId: string) => {
                emitLifecycle(
                  () =>
                    lifecycleProducer.chatBound({
                      commandId: cmd._id,
                      launchId: cmd.launchId ?? null,
                      automationRunId: cmd.automationRunId ?? null,
                      harness,
                      environment: launcher.environment,
                      cwd: launchCwd,
                      linkedPath: linkedPath ?? null,
                      chatId: threadId,
                    }),
                  `codex bound ${threadId}`,
                );
                if (stampsLinkedFile) {
                  await linkCodexThread(
                    linkedPath,
                    threadId,
                    launchCwd,
                    launcher.environment,
                  );
                }
                await bindPendingChat(
                  cmd,
                  harness,
                  threadId,
                  launchCwd,
                  launcher.environment,
                );
              }
            : async (sessionId: string) => {
                emitLifecycle(
                  () =>
                    lifecycleProducer.chatBound({
                      commandId: cmd._id,
                      launchId: cmd.launchId ?? null,
                      automationRunId: cmd.automationRunId ?? null,
                      harness,
                      environment: launcher.environment,
                      cwd: launchCwd,
                      linkedPath: linkedPath ?? null,
                      chatId: sessionId,
                    }),
                  `claude bound ${sessionId}`,
                );
                if (stampsLinkedFile) {
                  await linkClaudeSession(
                    linkedPath,
                    sessionId,
                    launchCwd,
                    launcher.environment,
                  );
                }
                await bindPendingChat(
                  cmd,
                  harness,
                  sessionId,
                  launchCwd,
                  launcher.environment,
                );
              };
        const onSettled =
          harness === "codex"
            ? async (threadId: string) => {
                const latestThread = await latestCodexThread(threadId).catch(
                  () => null,
                );
                emitLifecycle(
                  () =>
                    lifecycleProducer.turnCompleted({
                      commandId: cmd._id,
                      launchId: cmd.launchId ?? null,
                      automationRunId: cmd.automationRunId ?? null,
                      harness,
                      environment: launcher.environment,
                      cwd: launchCwd,
                      linkedPath: linkedPath ?? null,
                      chatId: threadId,
                      title: latestThread?.title ?? null,
                    }),
                  `codex completed ${threadId}`,
                );
                await settlePendingChat(
                  cmd,
                  harness,
                  threadId,
                  launchCwd,
                  launcher.environment,
                );
              }
            : undefined;
        const { result } = await launcher.startNew({
          launchId: cmd.launchId,
          taskKey: launchKey,
          prompt: cmd.initialPrompt,
          cwd: launchCwd,
          title,
          model: cmd.model,
          effort: cmd.effort,
          project,
          onLinked,
          onSettled,
          logger,
        });
        await complete(cmd, "done", result);
        logger.info(
          `[hitch:${projectLabel}] ⮑ start-chat ${harness} ${launchKey} → ${result}`,
        );
      } else {
        await complete(
          cmd,
          "error",
          `unsupported command: ${cmd.kind}/${cmd.harness}`,
        );
      }
    } catch (err) {
      // Tag known cmux failures so the browser can guide the user (e.g. flip the
      // cmux socket mode) instead of surfacing a raw "Broken pipe".
      const errorCode = err instanceof CmuxError ? err.code : undefined;
      await complete(cmd, "error", String(err), errorCode);
      logger.info(`[hitch:${projectLabel}] ⚠ command ${cmd._id} failed: ${String(err)}`);
    }
  }

  subscriptions.push(
    client.onUpdate(
      anyApi.commands.pendingCommands,
      { projectId, deviceToken },
      (commands: CommandDoc[]) => {
        for (const cmd of commands) {
          if (handledCommands.has(cmd._id)) continue;
          if (cmd.host && cmd.host !== host) continue;
          handledCommands.add(cmd._id);
          void (async () => {
            try {
              const claimed = await claimCommand(cmd);
              if (!claimed) return;
              await runCommand(claimed);
            } catch (err) {
              handledCommands.delete(cmd._id);
              logError(
                logger,
                `[hitch:${projectLabel}] command claim failed for ${cmd._id}: ${String(err)}`,
              );
            }
          })();
        }
      },
      (err) =>
        logError(logger, `[hitch:${projectLabel}] command subscription failed: ${String(err)}`),
    ),
  );

  const watcher: FSWatcher = chokidar.watch(root.hitchPath, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher
    .on("add", (path) =>
      void pushLocal(path).catch((err) =>
        logError(logger, `[hitch:${projectLabel}] add failed for ${path}: ${String(err)}`),
      ),
    )
    .on("change", (path) =>
      void pushLocal(path).catch((err) =>
        logError(logger, `[hitch:${projectLabel}] change failed for ${path}: ${String(err)}`),
      ),
    )
    .on("unlink", (path) =>
      void pushDelete(path).catch((err) =>
        logError(logger, `[hitch:${projectLabel}] unlink failed for ${path}: ${String(err)}`),
      ),
    )
    .on("error", (err) =>
      logError(logger, `[hitch:${projectLabel}] watcher failed: ${err}`),
    )
    .on("ready", () =>
      logger.info(`[hitch:${projectLabel}] watching ${root.hitchPath}`),
    );

  let stopped = false;
  return {
    chatLifecycleStore,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(reconcileTimer);
      clearInterval(chatReducePollTimer);
      if (titleRefreshTimer) clearTimeout(titleRefreshTimer);
      if (reduceDebounce) clearTimeout(reduceDebounce);
      for (const subscription of subscriptions) unsubscribe(subscription);
      await chatBumpWatcher.close();
      await watcher.close();
      chatLifecycleStore.close();
    },
  };
}

export async function startHitchDaemon(
  options: HitchDaemonOptions = {},
): Promise<HitchDaemonHandle> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const envFiles = options.envFiles ?? [".env.local", ".env"];
  loadEnvFiles(cwd, envFiles, env);

  const convexUrl = deriveConvexUrl(env);
  if (!convexUrl) {
    throw new Error(
      "[hitch] No Convex deployment found.\n" +
        "        Run `npx convex dev` once (it writes CONVEX_DEPLOYMENT to\n" +
        "        .env.local), or set CONVEX_URL=https://your-deployment.convex.cloud\n" +
        "        in .env explicitly.",
    );
  }

  const configPath = options.configPath
    ? resolve(cwd, options.configPath)
    : defaultConfigPath(cwd);
  const config = loadHitchConfig(configPath, cwd);
  const deviceToken =
    env.HITCH_DEVICE_TOKEN?.trim() || env.HITCH_DAEMON_TOKEN?.trim();
  if (!deviceToken) {
    throw new Error(
      "[hitch] Missing HITCH_DEVICE_TOKEN.\n" +
        "        Create a device token for this user/device, then set\n" +
        "        HITCH_DEVICE_TOKEN=<token> in .env or .env.local.",
    );
  }

  const client = new ConvexClient(convexUrl);
  const host = hostname();
  const bindingHandles = await Promise.all(
    config.hitches.map((hitch) =>
      startHitchBinding({
        client,
        env,
        deviceToken,
        hitch,
        logger,
        host,
        configPath,
      }),
    ),
  );
  const primaryHitch = config.hitches[0];
  const conflicts = bindingHandles
    .map((binding) => binding.conflict)
    .filter((conflict): conflict is ProjectConflict => Boolean(conflict));

  // All bindings open the same local DB, so any one store can serve the debug
  // reads; reconciliation hits cmux globally regardless. Null only if every
  // binding is conflicted (none opened a store).
  const debugStore = bindingHandles.find(
    (binding) => binding.chatLifecycleStore,
  )?.chatLifecycleStore;
  const debug = debugStore ? createDebugApi(debugStore) : null;

  // The chat-state observer runs once per machine (not per binding): it
  // discovers Claude + Codex chats across every hitched project, maps each by
  // cwd, and writes observed state into the shared store's shadow columns. The
  // per-binding reduce/sync poll then carries those shadow fields to Convex. It
  // shares any binding's store connection (all open the same DB file).
  let observer: ChatStateObserver | null = null;
  if (debugStore && config.hitches.length > 0) {
    observer = new ChatStateObserver({
      store: debugStore,
      projects: config.hitches.map((hitch) => ({
        projectId: hitch.projectId,
        localPath: hitch.localPath,
      })),
      host,
      logger,
    });
    observer.start();
  }

  // Skills are a per-machine derived index too: scan each hitched project's skill
  // directories (the global ~/.claude|~/.codex roots plus the project's own
  // .claude|.codex) and replace its `skills` rows on startup + every 5 minutes.
  // Deliberately interval-driven, not watched — the daemon has a history of fd
  // exhaustion from per-file watches. Non-fatal; failures are logged.
  const skillSync = startSkillSync({
    client,
    deviceToken,
    host,
    projects: config.hitches.map((hitch) => ({
      projectId: hitch.projectId,
      localPath: hitch.localPath,
    })),
    logger,
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    skillSync.stop();
    await observer?.stop();
    await Promise.all(bindingHandles.map((binding) => binding.stop()));
    await closeCodexAppServer();
    await closeT3Code();
    await stopClaudeSessionLinker();
    await client.close();
  }

  return {
    projectId: primaryHitch.projectId,
    localPath: primaryHitch.localPath,
    hitchPath: primaryHitch.hitchPath,
    hitches: config.hitches,
    conflicts,
    debug,
    stop,
  };
}
