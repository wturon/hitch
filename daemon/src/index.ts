// Hitch daemon: watch configured .hitch/ folders and keep them in sync with
// Convex. Local file changes are pushed up; remote changes are written back to
// disk. Echo suppression (a per-path hash of what we last applied) stops a
// synced write from looping back out.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import dotenv from "dotenv";
import chokidar from "chokidar";
import WebSocket from "ws";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { openChat, startChat } from "./cmux.js";
import {
  closeCodexAppServer,
  openCodexDraft,
  startCodexChat,
} from "./codex.js";

// Convex's reactive client uses WebSocket; polyfill for Node < 22.
if (!globalThis.WebSocket) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}

// --- types ---
interface WatchEntry {
  label: string;
  path: string;
}
interface HitchConfig {
  workspace: string;
  watch: WatchEntry[];
}
// Shape of a row returned by the listFiles query (anyApi is untyped).
interface FileDoc {
  workspace: string;
  source: string;
  path: string;
  content: string;
  hash: string;
  deleted: boolean;
  updatedAt: number;
}
interface Root {
  label: string;
  path: string;
}
// A queued action from the web UI (anyApi is untyped).
interface CommandDoc {
  _id: string;
  workspace: string;
  host?: string;
  kind: string;
  harness: string;
  sessionId?: string;
  source?: string;
  path?: string;
  initialPrompt?: string;
  cwd?: string;
  status: string;
}

// --- env ---
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

// `npx convex dev` writes CONVEX_DEPLOYMENT (e.g. "dev:happy-otter-123") to
// .env.local. The cloud URL for that deployment is https://<name>.convex.cloud,
// so derive it when CONVEX_URL isn't set explicitly.
function deriveConvexUrl(): string | undefined {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  const deployment = process.env.CONVEX_DEPLOYMENT;
  if (!deployment) return undefined;
  const name = deployment.includes(":")
    ? deployment.split(":")[1]
    : deployment;
  return name ? `https://${name}.convex.cloud` : undefined;
}

const CONVEX_URL = deriveConvexUrl();
if (!CONVEX_URL) {
  console.error(
    "[hitch] No Convex deployment found.\n" +
      "        Run `npx convex dev` once (it writes CONVEX_DEPLOYMENT to\n" +
      "        .env.local), or set CONVEX_URL=https://your-deployment.convex.cloud\n" +
      "        in .env explicitly.",
  );
  process.exit(1);
}

// --- config ---
function failConfig(message: string): never {
  console.error(`[hitch] Invalid hitch.config.json: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadConfig(path: string): HitchConfig {
  if (!existsSync(path)) {
    console.error(`[hitch] No config found at ${path}`);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    failConfig(`could not read ${path}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failConfig(`could not parse JSON: ${String(err)}`);
  }

  if (!isRecord(parsed)) failConfig("expected a JSON object at the top level");

  const workspace =
    typeof parsed.workspace === "string" ? parsed.workspace.trim() : "";
  if (!workspace) failConfig("workspace must be a non-empty string");

  if (!Array.isArray(parsed.watch)) failConfig("watch must be an array");
  if (parsed.watch.length === 0) {
    failConfig("watch must list at least one folder");
  }

  const labels = new Set<string>();
  const watch = parsed.watch.map((entry, index): WatchEntry => {
    if (!isRecord(entry)) failConfig(`watch[${index}] must be an object`);

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const watchPath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!label) failConfig(`watch[${index}].label must be a non-empty string`);
    if (!watchPath) failConfig(`watch[${index}].path must be a non-empty string`);
    if (labels.has(label)) failConfig(`duplicate watch label "${label}"`);
    labels.add(label);

    return { label, path: watchPath };
  });

  return { workspace, watch };
}

const configPath = resolve("hitch.config.json");
const config = loadConfig(configPath);
const workspace = config.workspace;
const roots: Root[] = config.watch.map((w) => ({
  label: w.label,
  path: resolve(w.path),
}));
for (const root of roots) {
  mkdirSync(root.path, { recursive: true });
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

// The hash we last synced for each absolute path. If a filesystem event or a
// remote update carries a hash we already have, it's an echo and we skip it.
const lastHash = new Map<string, string>();

// absolute path -> { label, rel } using the watched roots (rel uses "/")
function locate(absPath: string): { label: string; rel: string } | null {
  for (const root of roots) {
    const rel = relative(root.path, absPath);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) {
      return { label: root.label, rel: rel.split(sep).join("/") };
    }
  }
  return null;
}

// { label, rel } from Convex -> absolute path (null if this machine doesn't
// watch that source)
function toAbs(label: string, rel: string): string | null {
  const root = roots.find((r) => r.label === label);
  return root ? join(root.path, rel.split("/").join(sep)) : null;
}

async function linkCodexThread(source: string, path: string, threadId: string) {
  const absPath = toAbs(source, path);
  if (!absPath) throw new Error(`unknown source: ${source}`);

  const current = await readFile(absPath, "utf8");
  const next = setFrontmatterKeys(current, {
    "chat-harness": "codex",
    "chat-id": threadId,
    "chat-cwd": undefined,
  });
  await writeFile(absPath, next, "utf8");
  console.log(`[hitch] linked codex thread ${threadId} → ${source}/${path}`);
}

async function taskTitle(source: string, path: string): Promise<string | undefined> {
  const absPath = toAbs(source, path);
  if (!absPath) return undefined;
  try {
    return frontmatterValue(await readFile(absPath, "utf8"), "title");
  } catch {
    return undefined;
  }
}

const client = new ConvexClient(CONVEX_URL);

// --- local -> Convex ---
async function pushLocal(absPath: string): Promise<void> {
  const loc = locate(absPath);
  if (!loc) return;
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return; // file vanished between the event and the read
  }
  const hash = hashOf(content);
  if (lastHash.get(absPath) === hash) return; // echo of something we applied
  lastHash.set(absPath, hash);
  await client.mutation(anyApi.files.upsertFile, {
    workspace,
    source: loc.label,
    path: loc.rel,
    content,
    hash,
    deleted: false,
  });
  console.log(`[hitch] ↑ ${loc.label}/${loc.rel}`);
}

async function pushDelete(absPath: string): Promise<void> {
  const loc = locate(absPath);
  if (!loc) return;
  lastHash.delete(absPath);
  await client.mutation(anyApi.files.upsertFile, {
    workspace,
    source: loc.label,
    path: loc.rel,
    content: "",
    hash: "",
    deleted: true,
  });
  console.log(`[hitch] ✗ ${loc.label}/${loc.rel}`);
}

// --- Convex -> local ---
client.onUpdate(
  anyApi.files.listFiles,
  { workspace },
  async (files: FileDoc[]) => {
    for (const f of files) {
      const absPath = toAbs(f.source, f.path);
      if (!absPath) continue; // a source this machine doesn't watch

      if (f.deleted) {
        if (existsSync(absPath)) {
          lastHash.delete(absPath);
          await rm(absPath, { force: true });
          console.log(`[hitch] ↓✗ ${f.source}/${f.path}`);
        }
        continue;
      }

      // Decide based on the hash of the actual content, not the row's stored
      // `hash` field — so an edit made directly in the Convex dashboard (which
      // doesn't recompute `hash`) still propagates to disk.
      const contentHash = hashOf(f.content);
      if (lastHash.get(absPath) === contentHash) continue; // already have it
      // Record BEFORE writing so the watcher event this write triggers is
      // recognised as an echo and dropped.
      lastHash.set(absPath, contentHash);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, f.content, "utf8");
      console.log(`[hitch] ↓ ${f.source}/${f.path}`);
    }
  },
);

// --- heartbeat ---
// Tell Convex this machine is alive and what it's watching, so the board can
// show sync health. Sent on startup and every 15s.
const HEARTBEAT_MS = 15_000;
const host = hostname();
const sources = roots.map((r) => r.label);

async function sendHeartbeat(): Promise<void> {
  try {
    await client.mutation(anyApi.status.heartbeat, {
      workspace,
      hostname: host,
      sources,
    });
  } catch {
    // transient — the next tick will retry
  }
}

void sendHeartbeat();
const heartbeatTimer = setInterval(() => void sendHeartbeat(), HEARTBEAT_MS);

// --- command queue ---
// The browser can't open a terminal, so it enqueues commands and this daemon
// runs them locally. We subscribe to the pending set; each command is handled
// once (handledCommands guards against the query re-firing before the status
// flips to done) and only if it targets this machine.
const handledCommands = new Set<string>();

async function runCommand(cmd: CommandDoc): Promise<void> {
  try {
    if (cmd.kind === "open-chat" && cmd.harness === "claude-code") {
      const sessionId = cmd.sessionId ?? "";
      const result = await openChat({ sessionId, cwd: cmd.cwd });
      await client.mutation(anyApi.commands.completeCommand, {
        id: cmd._id,
        status: "done",
        result,
      });
      console.log(`[hitch] ⮑ open-chat ${sessionId} → ${result}`);
    } else if (cmd.kind === "start-chat" && cmd.harness === "claude-code") {
      // Spawn a fresh session for a task. Resolve the agent's cwd from the
      // task's source: the watched root is the `.hitch/` folder, so the repo
      // working dir the agent should run in is its parent.
      const root = roots.find((r) => r.label === cmd.source);
      if (!root) throw new Error(`unknown source: ${cmd.source}`);
      if (!cmd.initialPrompt) throw new Error("start-chat requires initialPrompt");
      const result = await startChat({
        taskKey: `${cmd.source}/${cmd.path}`,
        prompt: cmd.initialPrompt,
        cwd: dirname(root.path),
      });
      await client.mutation(anyApi.commands.completeCommand, {
        id: cmd._id,
        status: "done",
        result,
      });
      console.log(`[hitch] ⮑ start-chat ${cmd.source}/${cmd.path} → ${result}`);
    } else if (cmd.kind === "start-chat" && cmd.harness === "codex") {
      const root = roots.find((r) => r.label === cmd.source);
      if (!root) throw new Error(`unknown source: ${cmd.source}`);
      if (!cmd.path) throw new Error("start-chat requires path");
      if (!cmd.source) throw new Error("start-chat requires source");
      if (!cmd.initialPrompt) throw new Error("start-chat requires initialPrompt");

      const cwd = dirname(root.path);
      let result: string;
      if (process.env.HITCH_CODEX_START_MODE === "app-server") {
        const started = await startCodexChat({
          taskKey: `${cmd.source}/${cmd.path}`,
          prompt: cmd.initialPrompt,
          cwd,
          threadName: await taskTitle(cmd.source, cmd.path),
          onThreadStarted: (threadId) =>
            linkCodexThread(cmd.source as string, cmd.path as string, threadId),
        });
        result = `${started.status}:${started.threadId}`;
      } else {
        result = await openCodexDraft({
          prompt: cmd.initialPrompt,
          cwd,
        });
      }
      await client.mutation(anyApi.commands.completeCommand, {
        id: cmd._id,
        status: "done",
        result,
      });
      console.log(
        `[hitch] ⮑ start-chat codex ${cmd.source}/${cmd.path} → ${result}`,
      );
    } else {
      await client.mutation(anyApi.commands.completeCommand, {
        id: cmd._id,
        status: "error",
        result: `unsupported command: ${cmd.kind}/${cmd.harness}`,
      });
    }
  } catch (err) {
    await client.mutation(anyApi.commands.completeCommand, {
      id: cmd._id,
      status: "error",
      result: String(err),
    });
    console.log(`[hitch] ⚠ command ${cmd._id} failed: ${String(err)}`);
  }
}

client.onUpdate(
  anyApi.commands.pendingCommands,
  { workspace },
  (commands: CommandDoc[]) => {
    for (const cmd of commands) {
      if (handledCommands.has(cmd._id)) continue;
      if (cmd.host && cmd.host !== host) continue; // pinned to another machine
      handledCommands.add(cmd._id);
      void runCommand(cmd);
    }
  },
);

// --- watcher ---
const watcher = chokidar.watch(
  roots.map((r) => r.path),
  {
    ignoreInitial: false, // sync files that already exist on startup
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  },
);
watcher
  .on("add", pushLocal)
  .on("change", pushLocal)
  .on("unlink", pushDelete)
  .on("ready", () =>
    console.log(
      `[hitch] watching ${roots.length} folder(s) for workspace "${workspace}"`,
    ),
  );

async function shutdown(): Promise<void> {
  clearInterval(heartbeatTimer);
  await watcher.close();
  await closeCodexAppServer();
  await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
