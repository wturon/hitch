// Hitch daemon: watch configured .hitch/ folders and keep them in sync with
// Convex. Local file changes are pushed up; remote changes are written back to
// disk. Echo suppression (a per-path hash of what we last applied) stops a
// synced write from looping back out.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import dotenv from "dotenv";
import chokidar from "chokidar";
import WebSocket from "ws";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

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

// --- env ---
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });
const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error(
    "[hitch] CONVEX_URL is not set.\n" +
      "        Run `npx convex dev` once, then put the printed deployment URL\n" +
      "        in .env as CONVEX_URL=https://your-deployment.convex.cloud",
  );
  process.exit(1);
}

// --- config ---
const configPath = resolve("hitch.config.json");
if (!existsSync(configPath)) {
  console.error(`[hitch] No config found at ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as HitchConfig;
const workspace = config.workspace;
const roots: Root[] = (config.watch ?? []).map((w) => ({
  label: w.label,
  path: resolve(w.path),
}));
if (roots.length === 0) {
  console.error("[hitch] hitch.config.json lists no folders to watch.");
  process.exit(1);
}

const hashOf = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

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

      if (lastHash.get(absPath) === f.hash) continue; // already have it
      // Record the hash BEFORE writing so the watcher event this write
      // triggers is recognised as an echo and dropped.
      lastHash.set(absPath, f.hash);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, f.content, "utf8");
      console.log(`[hitch] ↓ ${f.source}/${f.path}`);
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
  await watcher.close();
  await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
