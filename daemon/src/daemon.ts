// Hitch daemon runtime: watch projects' local .hitch/ folders and keep them in
// sync with Convex. This module is importable by the CLI, Electron runner, and
// tests; it does not install signal handlers or call process.exit().

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { CmuxError } from "./cmux.js";
import { closeCodexAppServer, latestCodexTurn } from "./codex.js";
import { resolveLauncher } from "./launchers/registry.js";
import { stopClaudeSessionLinker } from "./launchers/claudeSessionLinker.js";
import type { Environment, Harness } from "./launchers/types.js";

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

export interface HitchDaemonHandle {
  projectId: string;
  localPath: string;
  hitchPath: string;
  hitches: ResolvedHitch[];
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

interface CommandDoc {
  _id: string;
  projectId: string;
  host?: string;
  kind: string;
  harness: string;
  environment?: string; // unset in release 1; daemon derives from harness default
  sessionId?: string;
  path?: string;
  initialPrompt?: string;
  cwd?: string;
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
const FINISHED_CODEX_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
]);

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

interface HitchBindingHandle {
  stop: () => Promise<void>;
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
  }

  subscriptions.push(
    client.onUpdate(
      anyApi.files.listFiles,
      { projectId, deviceToken },
      async (files: FileDoc[]) => {
        for (const f of files) {
          const absPath = toAbs(f.path);

          if (f.deleted) {
            if (existsSync(absPath)) {
              lastHash.delete(absPath);
              await rm(absPath, { force: true });
              logger.info(`[hitch:${projectLabel}] ↓✗ ${f.path}`);
            }
            continue;
          }

          const contentHash = hashOf(f.content);
          if (lastHash.get(absPath) === contentHash) continue;
          lastHash.set(absPath, contentHash);
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, f.content, "utf8");
          logger.info(`[hitch:${projectLabel}] ↓ ${f.path}`);
        }
      },
      (err) =>
        logError(logger, `[hitch:${projectLabel}] files subscription failed: ${String(err)}`),
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
  // per-session pid, so pid death clears stale working/waiting. Codex has no
  // per-chat process; global hooks are the live signal, and this loop only
  // settles stale working cards once durable turn history says the turn ended.
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
      if (status !== "working" && status !== "waiting") continue;
      const harness = frontmatterValue(content, "chat-harness") ?? "";

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

      if (harness === "codex" && status === "working") {
        const threadId = frontmatterValue(content, "chat-id") ?? "";
        if (!threadId) continue;

        let latestTurn;
        try {
          latestTurn = await latestCodexTurn(threadId);
        } catch {
          continue; // transient app-server/read issue; retry next tick
        }
        if (!latestTurn || !FINISHED_CODEX_TURN_STATUSES.has(latestTurn.status)) {
          continue;
        }

        const next = setFrontmatterKeys(content, {
          "chat-status": settledChatStatus(content),
          "chat-open-state": undefined,
        });
        if (next === content) continue;
        try {
          await writeFile(absPath, next, "utf8");
          logger.info(
            `[hitch:${projectLabel}] healed stale codex chat-status (latest turn ${latestTurn.id} ${latestTurn.status}) → tasks/${entry.name}/task.md`,
          );
        } catch {
          // best-effort; the next tick retries
        }
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
      const environment =
        (cmd.environment as Environment | undefined) ??
        readHarnessEnvironment(configPath, harness);
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
          project,
          onLinked,
          onSettled,
          logger,
        });
        await complete(cmd, "done", result);
        logger.info(
          `[hitch:${projectLabel}] ⮑ start-chat ${harness} ${path} → ${result}`,
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

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    await Promise.all(bindingHandles.map((binding) => binding.stop()));
    await closeCodexAppServer();
    await stopClaudeSessionLinker();
    await client.close();
  }

  return {
    projectId: primaryHitch.projectId,
    localPath: primaryHitch.localPath,
    hitchPath: primaryHitch.hitchPath,
    hitches: config.hitches,
    stop,
  };
}
