// Hitch daemon runtime: watch projects' local .hitch/ folders and keep them in
// sync with Convex. This module is importable by the CLI, Electron runner, and
// tests; it does not install signal handlers or call process.exit().

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import dotenv from "dotenv";
import chokidar, { type FSWatcher } from "chokidar";
import WebSocket from "ws";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { CmuxError, setCmuxLogger } from "./cmux.js";
import { closeCodexAppServer } from "./codex.js";
import { closeT3Code, setT3Logger } from "./t3code.js";
import { resolveLauncher } from "./launchers/registry.js";
import { stopClaudeSessionLinker } from "./launchers/claudeSessionLinker.js";
import type { Environment, Harness } from "./launchers/types.js";
import {
  type ScannedLoop,
  cronNextRun,
  readLoopLocalState,
  runTrigger,
  scanLoops,
} from "./loops.js";

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
  sessionId?: string;
  path?: string;
  loopPath?: string; // loop-run: the loop dir rel to .hitch/ (e.g. "loops/pr-review")
  initialPrompt?: string;
  cwd?: string;
  model?: string; // start-chat kickoff: model to launch
  effort?: string; // start-chat kickoff: reasoning/effort level
  status: string;
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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Files under a task's or note's attachments/ folder are image blobs, NOT UTF-8
// text. They sync via the attachments table (download-only), so the text watcher
// must never read/push them — doing so would shove corrupted binary into the
// `files` table and pollute the cards query. Matches both a file and the dir
// itself, under either primitive's folder.
const ATTACHMENT_RE = /^(?:tasks|notes)\/[^/]+\/attachments(\/|$)/;
// A single attachment file's path, used to scope empty-folder pruning.
const ATTACHMENT_FILE_RE = /^(?:tasks|notes)\/[^/]+\/attachments\/[^/]+$/;

function setFrontmatterKeys(
  content: string,
  updates: Record<string, string | undefined>,
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const match = content.match(FRONTMATTER_RE);
  let lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? match[2] : content;
  const touched = new Set(Object.keys(updates));

  lines = lines.filter((line) => {
    const idx = line.indexOf(":");
    return idx === -1 || !touched.has(line.slice(0, idx).trim());
  });

  for (const [key, value] of Object.entries(updates)) {
    if (value != null && value !== "") lines.push(`${key}: ${value}`);
  }

  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
}

function frontmatterValue(content: string, key: string): string | undefined {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return undefined;

  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    return line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const execFileP = promisify(execFile);
const TERMINAL_TASK_STATUSES = new Set(["archived", "done"]);
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

function taskStatus(content: string): string {
  return (frontmatterValue(content, "status") ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function settledChatStatus(content: string): string | undefined {
  return TERMINAL_TASK_STATUSES.has(taskStatus(content)) ? undefined : "waiting";
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

  async function linkCodexThread(path: string, threadId: string) {
    const absPath = toAbs(path);
    const current = await readFile(absPath, "utf8");
    // Stamp chat-status: working in the same write that links the thread. The
    // daemon is about to submit the first turn, so the chat is working *now* —
    // don't wait for the codex Stop hook (the first lifecycle event we'd
    // otherwise see) to light up the card.
    const next = setFrontmatterKeys(current, {
      "chat-harness": "codex",
      "chat-id": threadId,
      "chat-cwd": undefined,
      "chat-status": "working",
      "chat-open-state": "pending",
    });
    await writeFile(absPath, next, "utf8");
    logger.info(`[hitch:${projectLabel}] linked codex thread ${threadId} → ${path}`);
  }

  async function settleCodexThread(path: string, threadId: string) {
    const absPath = toAbs(path);
    const current = await readFile(absPath, "utf8");
    if (frontmatterValue(current, "chat-id") !== threadId) return;

    const next = setFrontmatterKeys(current, {
      "chat-status": "waiting",
      "chat-open-state": undefined,
    });
    await writeFile(absPath, next, "utf8");
    logger.info(`[hitch:${projectLabel}] codex thread ${threadId} is waiting → ${path}`);
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
    // discovered id (vscode/cursor) — either way link before/at first turn. Stamp
    // chat-status: working in the same write; the Stop hook settles it to waiting
    // later. chat-env records which environment owns the session so the daemon's
    // pid-healing knows whether to apply (only for process-lifecycle envs).
    const next = setFrontmatterKeys(current, {
      "chat-harness": "claude-code",
      "chat-id": sessionId,
      "chat-cwd": cwd,
      "chat-env": environment,
      "chat-status": "working",
    });
    await writeFile(absPath, next, "utf8");
    logger.info(`[hitch:${projectLabel}] linked claude session ${sessionId} → ${path}`);
  }

  async function taskTitle(path: string): Promise<string | undefined> {
    try {
      return frontmatterValue(await readFile(toAbs(path), "utf8"), "title");
    } catch {
      return undefined;
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

  // Remove the now-empty folder left behind when a task's task.md or a note's
  // index.md is deleted. rmdir fails on a non-empty dir — that's the signal to
  // stop, not an error.
  async function pruneEmptyTaskDir(relPath: string, absPath: string): Promise<void> {
    if (!/^(?:tasks\/[^/]+\/task\.md|notes\/[^/]+\/index\.md)$/.test(relPath))
      return;

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
    const tasksDir = join(root.hitchPath, "tasks");
    let entries;
    try {
      entries = await readdir(tasksDir, { withFileTypes: true });
    } catch {
      return; // no tasks dir yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absPath = join(tasksDir, entry.name, "task.md");
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

        const next = setFrontmatterKeys(content, {
          "chat-status": undefined,
          "chat-pid": undefined,
        });
        if (next === content) continue;
        try {
          await writeFile(absPath, next, "utf8");
          logger.info(
            `[hitch:${projectLabel}] healed stale claude chat-status (pid ${pid} gone) → tasks/${entry.name}/task.md`,
          );
        } catch {
          // best-effort; the next tick retries
        }
        continue;
      }
    }
  }

  void reconcileChatStatus();
  const reconcileTimer = setInterval(
    () => void reconcileChatStatus().catch(() => {}),
    15_000,
  );

  // ── Loops scheduler ────────────────────────────────────────────────────
  // In-process poller over on-disk loops ∩ locally-enabled. Stateless across
  // restarts: next-due is recomputed from cron, seeded to "now" on first sight
  // so a restart never replays missed ticks (no catch-up). Concurrency=skip is
  // an in-memory set of loops currently running on this host.
  const prefsPath = join(dirname(configPath), "preferences.json");
  const loopNextDueAt = new Map<string, number>(); // loopPath → next fire (ms)
  const loopSchedule = new Map<string, string>(); // loopPath → cron (change detect)
  const activeLoopRuns = new Set<string>(); // loopPath running on this host

  function readPrefsRaw(): string | null {
    try {
      return readFileSync(prefsPath, "utf8");
    } catch {
      return null;
    }
  }

  async function createLoopRun(args: {
    loop: ScannedLoop;
    reason: "cron" | "manual";
    status: string;
    triggerExitCode?: number;
    triggerStdout?: string;
    triggerStderr?: string;
    error?: string;
  }): Promise<string | null> {
    const startedAt = Date.now();
    const terminal = args.status !== "running";
    try {
      return (await client.mutation(anyApi.loops.createRun, {
        projectId,
        deviceToken,
        loopPath: args.loop.loopPath,
        host,
        status: args.status,
        reason: args.reason,
        startedAt,
        finishedAt: terminal ? startedAt : undefined,
        durationMs: terminal ? 0 : undefined,
        triggerExitCode: args.triggerExitCode,
        triggerStdout: args.triggerStdout,
        triggerStderr: args.triggerStderr,
        harness: args.loop.harness,
        model: args.loop.model,
        reasoning: args.loop.reasoning,
        error: args.error,
      })) as string;
    } catch (e) {
      logError(logger, `[hitch:${projectLabel}] loop createRun failed: ${String(e)}`);
      return null;
    }
  }

  // Phase 4 replaces this with the real Claude/Codex launch + done-watch +
  // teardown. For now it finalizes the run so records don't dangle.
  async function launchLoopAgent(
    loop: ScannedLoop,
    runId: string,
  ): Promise<void> {
    logger.info(
      `[hitch:${projectLabel}] loop ${loop.slug} → would launch ${loop.harness} (agent launch lands in Phase 4)`,
    );
    try {
      await client.mutation(anyApi.loops.patchRun, {
        id: runId,
        projectId,
        deviceToken,
        status: "ran",
        finishedAt: Date.now(),
        durationMs: 0,
        summary: "(agent launch not yet wired — Phase 4)",
      });
    } catch (e) {
      logError(logger, `[hitch:${projectLabel}] loop patchRun failed: ${String(e)}`);
    }
  }

  // Run one loop: trigger gate (scheduled only — manual bypasses it), then
  // launch. Trust is re-checked against the local hash on every scheduled run.
  async function executeLoop(
    loop: ScannedLoop,
    reason: "cron" | "manual",
  ): Promise<void> {
    if (activeLoopRuns.has(loop.loopPath)) {
      logger.info(
        `[hitch:${projectLabel}] loop ${loop.slug} skipped (already running on this host)`,
      );
      return;
    }

    let triggerExitCode: number | undefined;
    let triggerStdout: string | undefined;
    let triggerStderr: string | undefined;

    if (reason === "cron" && loop.triggerAbsPath && loop.triggerRelPath) {
      const local = readLoopLocalState(readPrefsRaw(), projectId);
      const trusted = local[loop.loopPath]?.trusted ?? {};
      let bytes = "";
      try {
        bytes = await readFile(loop.triggerAbsPath, "utf8");
      } catch {
        bytes = "";
      }
      if (bytes) {
        if (trusted[loop.triggerRelPath] !== hashOf(bytes)) {
          await createLoopRun({
            loop,
            reason,
            status: "skipped",
            error: "trigger.sh not trusted (review required)",
          });
          logger.info(
            `[hitch:${projectLabel}] loop ${loop.slug} skipped (untrusted trigger)`,
          );
          return;
        }
        const res = await runTrigger(loop.triggerAbsPath, root.localPath);
        triggerStdout = res.stdout;
        triggerStderr = res.stderr;
        triggerExitCode = res.exitCode ?? undefined;
        if (res.timedOut || res.exitCode === null) {
          await createLoopRun({
            loop,
            reason,
            status: "trigger-error",
            triggerExitCode,
            triggerStdout,
            triggerStderr,
            error: "trigger.sh timed out",
          });
          return;
        }
        if (res.exitCode === 2) {
          await createLoopRun({
            loop,
            reason,
            status: "skipped",
            triggerExitCode,
            triggerStdout,
            triggerStderr,
          });
          logger.info(`[hitch:${projectLabel}] loop ${loop.slug} skipped (trigger exit 2)`);
          return;
        }
        if (res.exitCode !== 0) {
          await createLoopRun({
            loop,
            reason,
            status: "trigger-error",
            triggerExitCode,
            triggerStdout,
            triggerStderr,
          });
          return;
        }
      }
    }

    const runId = await createLoopRun({
      loop,
      reason,
      status: "running",
      triggerExitCode,
      triggerStdout,
      triggerStderr,
    });
    if (!runId) return;
    activeLoopRuns.add(loop.loopPath);
    try {
      await launchLoopAgent(loop, runId);
    } finally {
      activeLoopRuns.delete(loop.loopPath);
    }
  }

  async function loopTick(): Promise<void> {
    let loops: ScannedLoop[];
    try {
      loops = await scanLoops(root.hitchPath);
    } catch {
      return;
    }
    const local = readLoopLocalState(readPrefsRaw(), projectId);
    const now = Date.now();
    const seen = new Set<string>();
    for (const loop of loops) {
      seen.add(loop.loopPath);
      if (local[loop.loopPath]?.enabled !== true) {
        loopNextDueAt.delete(loop.loopPath);
        loopSchedule.delete(loop.loopPath);
        continue;
      }
      // (Re)seed on first sight or a schedule change — next fire is the next
      // cron occurrence after now, never a replay of a missed tick.
      if (
        loopSchedule.get(loop.loopPath) !== loop.schedule ||
        !loopNextDueAt.has(loop.loopPath)
      ) {
        loopSchedule.set(loop.loopPath, loop.schedule);
        const next = cronNextRun(loop.schedule, new Date(now));
        if (next) loopNextDueAt.set(loop.loopPath, next.getTime());
        else loopNextDueAt.delete(loop.loopPath);
        continue;
      }
      const due = loopNextDueAt.get(loop.loopPath);
      if (due == null || now < due) continue;
      // Advance the schedule before firing so a slow run can't double-fire.
      const next = cronNextRun(loop.schedule, new Date(now));
      if (next) loopNextDueAt.set(loop.loopPath, next.getTime());
      else loopNextDueAt.delete(loop.loopPath);
      void executeLoop(loop, "cron").catch((e) =>
        logError(logger, `[hitch:${projectLabel}] loop ${loop.slug} failed: ${String(e)}`),
      );
    }
    for (const key of [...loopNextDueAt.keys()]) {
      if (!seen.has(key)) {
        loopNextDueAt.delete(key);
        loopSchedule.delete(key);
      }
    }
  }

  void loopTick();
  const loopTimer = setInterval(() => void loopTick().catch(() => {}), 20_000);

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
      } else if (cmd.kind === "start-chat") {
        if (!launcher.startNew) {
          throw new Error(`start-chat not supported for ${cmd.harness}`);
        }
        if (!cmd.path) throw new Error("start-chat requires path");
        if (!cmd.initialPrompt) throw new Error("start-chat requires initialPrompt");
        const path = cmd.path;
        const onLinked =
          harness === "codex"
              ? (threadId: string) => linkCodexThread(path, threadId)
              : (sessionId: string) =>
                  linkClaudeSession(path, sessionId, root.localPath, launcher.environment);
        const onSettled =
          harness === "codex"
              ? (threadId: string) => settleCodexThread(path, threadId)
              : undefined;
        const { result } = await launcher.startNew({
          taskKey: path,
          prompt: cmd.initialPrompt,
          cwd: root.localPath,
          title: await taskTitle(path),
          model: cmd.model,
          effort: cmd.effort,
          project,
          onLinked,
          onSettled,
          logger,
        });
        await complete(cmd, "done", result);
        logger.info(
          `[hitch:${projectLabel}] ⮑ start-chat ${harness} ${path} → ${result}`,
        );
      } else if (cmd.kind === "loop-run") {
        // Manual "Run now": run the loop pipeline immediately, bypassing the
        // trigger gate (reason: manual). Targeted at this host by the renderer.
        if (!cmd.loopPath) throw new Error("loop-run requires loopPath");
        const loops = await scanLoops(root.hitchPath);
        const loop = loops.find((l) => l.loopPath === cmd.loopPath);
        if (!loop) throw new Error(`loop not found: ${cmd.loopPath}`);
        await complete(cmd, "done", "started");
        logger.info(`[hitch:${projectLabel}] ⮑ loop-run ${cmd.loopPath} (manual)`);
        void executeLoop(loop, "manual").catch((e) =>
          logError(logger, `[hitch:${projectLabel}] manual loop ${loop.slug} failed: ${String(e)}`),
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
          void runCommand(cmd);
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
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(reconcileTimer);
      clearInterval(loopTimer);
      for (const subscription of subscriptions) unsubscribe(subscription);
      await watcher.close();
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

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
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
    stop,
  };
}
