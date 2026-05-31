// Reopen a coding-agent chat in cmux (https://cmux.com) — the terminal Will
// runs agents in. cmux tracks a "resume binding" per surface (via its Claude
// Code hooks) whose checkpoint_id is the session id. So "jump back to the chat"
// is: find the surface whose checkpoint_id matches this session and focus it;
// if none is open, spawn a new workspace that resumes the session from disk.
//
// Everything shells out to the `cmux` binary. We don't assume it's on PATH (a
// daemon launched outside cmux may not have it), so we probe known locations.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

const CMUX_CANDIDATES = [
  process.env.CMUX_BIN,
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
  "cmux", // PATH fallback
].filter((p): p is string => Boolean(p));

function cmuxBin(): string {
  for (const p of CMUX_CANDIDATES) {
    if (p === "cmux" || existsSync(p)) return p;
  }
  return "cmux";
}

async function cmux(args: string[]): Promise<string> {
  const { stdout } = await run(cmuxBin(), args, {
    timeout: 10_000,
    // A daemon outside cmux may need the socket password; pass it through if set.
    env: process.env,
  });
  return stdout;
}

// `cmux tree --all` spans every window, workspace, pane, and surface — important
// because per-window listings (list-workspaces) only see the current window, so
// a chat in another window would be missed and wrongly re-spawned.
const SURFACE_LINE_RE = /surface\s+surface:\d+\s+([0-9A-Fa-f-]{36})/g;
const WORKSPACE_LINE_RE = /workspace\s+workspace:\d+\s+([0-9A-Fa-f-]{36})/g;

async function tree(): Promise<string> {
  return cmux(["tree", "--all", "--id-format", "both"]).catch(() => "");
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

// The session id (checkpoint_id) bound to a surface, or null if it has none.
async function checkpointOf(surfaceUuid: string): Promise<string | null> {
  try {
    const out = await cmux([
      "rpc",
      "surface.resume.get",
      JSON.stringify({ surface_id: surfaceUuid }),
    ]);
    const data = JSON.parse(out) as {
      resume_binding?: { checkpoint_id?: string | null } | null;
    };
    return data.resume_binding?.checkpoint_id ?? null;
  } catch {
    return null;
  }
}

// The UUID of the surface whose resume binding targets this session, across all
// windows — or null if the chat isn't open anywhere.
async function findSurfaceUuid(sessionId: string): Promise<string | null> {
  for (const surface of matchAll(await tree(), SURFACE_LINE_RE)) {
    if ((await checkpointOf(surface)) === sessionId) return surface;
  }
  return null;
}

async function workspaceUuids(): Promise<Set<string>> {
  return new Set(matchAll(await tree(), WORKSPACE_LINE_RE));
}

// Bring the cmux app to the foreground at the OS level (the macOS equivalent of
// cmd-tabbing to it). cmux's own window.focus can't do this from a background
// process — macOS blocks apps from stealing focus — but LaunchServices'
// `open -a` is permitted to. macOS only; no-op elsewhere.
function appBundlePath(): string {
  const bin = cmuxBin();
  const marker = "/Contents/Resources/bin/";
  const idx = bin.indexOf(marker);
  return idx >= 0 ? bin.slice(0, idx) : "cmux";
}

async function activateApp(): Promise<void> {
  if (platform() !== "darwin") return;
  try {
    await run("/usr/bin/open", ["-a", appBundlePath()], { timeout: 5_000 });
  } catch {
    // Best-effort: the in-app focus already happened; only the OS raise failed.
  }
}

export interface OpenSpec {
  sessionId: string;
  cwd?: string;
  // The command to run when spawning fresh. Defaults to a plain resume.
  command?: string;
}

export type OpenResult = "focused" | "spawned";

// A chat we spawned but that hasn't reported its resume binding yet (claude
// takes a few seconds to boot). Until the binding appears, focus this workspace
// instead of spawning a duplicate. Also a synchronous in-flight guard against
// two near-simultaneous clicks both spawning.
const recentSpawns = new Map<string, { workspace: string; at: number }>();
const spawning = new Set<string>();
const SPAWN_GRACE_MS = 45_000;

// Bring the chat forward: focus its existing surface, or spawn a workspace that
// resumes the session from its on-disk transcript. Returns which path ran.
export async function openChat(spec: OpenSpec): Promise<OpenResult> {
  // 1. Open and bound → select the tab and raise the app.
  const uuid = await findSurfaceUuid(spec.sessionId);
  if (uuid) {
    recentSpawns.delete(spec.sessionId);
    await cmux(["rpc", "surface.focus", JSON.stringify({ surface_id: uuid })]);
    await activateApp();
    return "focused";
  }

  // 2. We spawned it moments ago but claude is still booting (no binding yet) →
  //    focus that workspace rather than spawn a duplicate.
  const memo = recentSpawns.get(spec.sessionId);
  if (memo && Date.now() - memo.at < SPAWN_GRACE_MS) {
    try {
      await cmux(["select-workspace", "--workspace", memo.workspace]);
      await activateApp();
      return "focused";
    } catch {
      recentSpawns.delete(spec.sessionId); // workspace gone; fall through
    }
  }

  // 3. A spawn for this session is mid-flight (concurrent click) → don't race.
  if (spawning.has(spec.sessionId)) {
    await activateApp();
    return "focused";
  }

  // 4. Genuinely not open → spawn and remember the workspace we created.
  spawning.add(spec.sessionId);
  try {
    const before = await workspaceUuids();
    const command = spec.command ?? `claude --resume ${spec.sessionId}`;
    const args = ["new-workspace", "--command", command, "--focus", "true"];
    if (spec.cwd) args.push("--cwd", spec.cwd);
    await cmux(args);
    const created = [...(await workspaceUuids())].find((w) => !before.has(w));
    if (created) {
      recentSpawns.set(spec.sessionId, { workspace: created, at: Date.now() });
    }
    await activateApp();
    return "spawned";
  } finally {
    spawning.delete(spec.sessionId);
  }
}

export interface StartSpec {
  taskKey: string; // dedup key for fresh spawns, e.g. "source/tasks/slug"
  prompt: string;
  cwd?: string;
}

// Launch a BRAND-NEW Claude Code session seeded with `prompt`, in a fresh cmux
// workspace. The prompt rides as claude's positional argument — NOT `-p` — so it
// stays an interactive session on subscription auth (the user drives it); claude
// just submits it as the first turn. There's no session id yet, so dedup keys on
// the task: a second click within the grace window focuses the workspace we just
// made instead of spawning a duplicate. The spawned agent writes its own session
// id back into the task frontmatter, after which the task is "linked" and
// openChat() takes over for resuming.
export async function startChat(spec: StartSpec): Promise<OpenResult> {
  // We spawned for this task moments ago (agent may still be booting) → focus
  // that workspace rather than spawn a duplicate.
  const memo = recentSpawns.get(spec.taskKey);
  if (memo && Date.now() - memo.at < SPAWN_GRACE_MS) {
    try {
      await cmux(["select-workspace", "--workspace", memo.workspace]);
      await activateApp();
      return "focused";
    } catch {
      recentSpawns.delete(spec.taskKey); // workspace gone; fall through
    }
  }

  // A spawn for this task is mid-flight (concurrent click) → don't race.
  if (spawning.has(spec.taskKey)) {
    await activateApp();
    return "focused";
  }

  spawning.add(spec.taskKey);
  try {
    const before = await workspaceUuids();
    const command = `claude ${shellQuote(spec.prompt)}`;
    const args = ["new-workspace", "--command", command, "--focus", "true"];
    if (spec.cwd) args.push("--cwd", spec.cwd);
    await cmux(args);
    const created = [...(await workspaceUuids())].find((w) => !before.has(w));
    if (created) {
      recentSpawns.set(spec.taskKey, { workspace: created, at: Date.now() });
    }
    await activateApp();
    return "spawned";
  } finally {
    spawning.delete(spec.taskKey);
  }
}

// Single-quote an arbitrary (possibly multi-line) string for sh, so the seed
// prompt survives intact as one argument when cmux runs `--command` via a shell.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
