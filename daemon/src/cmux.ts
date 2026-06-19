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

// Diagnostic logging. cmux.ts is otherwise dependency-free; the daemon wires its
// logger in once at startup (mirroring setT3Logger), so these lines land in the
// same local sync log stream as the daemon's other output. This bug — a chat
// resumed in a new tab, or the wrong tab focused, when it's already open — is
// timing-dependent and rare, so the point is to make the *next* occurrence
// self-explaining rather than to reproduce it. Quiet by default: one decision
// line per click plus warnings on swallowed RPC failures; the verbose
// surface→checkpoint dump only fires under HITCH_CMUX_DEBUG.
export interface CmuxLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

let logger: CmuxLogger | null = null;

export function setCmuxLogger(l: CmuxLogger): void {
  logger = l;
}

function log(message: string): void {
  logger?.info(`[cmux] ${message}`);
}

function warn(message: string): void {
  (logger?.error ?? logger?.info)?.(`[cmux] ⚠ ${message}`);
}

function cmuxDebug(): boolean {
  return Boolean(process.env.HITCH_CMUX_DEBUG);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// UUIDs are 36 chars; the first 8 are plenty to eyeball-match across log lines.
function short(id: string): string {
  return id.slice(0, 8);
}

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

// Why a connecting attempt failed, in terms the UI can act on:
// - access-denied: cmux is running but refused us. Its default "cmux processes
//   only" socket mode does an ancestry check, so a daemon launched from the Dock
//   (not from a cmux terminal) is rejected — the socket connects, then closes
//   mid-write ("Broken pipe"). The fix is a cmux Settings change, which the
//   desktop app surfaces as a guided dialog.
// - unavailable: cmux isn't installed / isn't running (binary missing, or no
//   socket to connect to). The fix is "open cmux and try again".
// - error: anything else; show the raw message.
export type CmuxErrorCode =
  | "cmux-access-denied"
  | "cmux-unavailable"
  | "cmux-error";

export class CmuxError extends Error {
  constructor(
    readonly code: CmuxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CmuxError";
  }
}

// Map a failed `cmux` invocation onto a CmuxErrorCode. execFile rejects with an
// ErrnoException that also carries the process's stdout/stderr; cmux prints its
// socket diagnostics there (e.g. "Failed to write to socket (Broken pipe, errno
// 32)"), so we classify on that text plus the spawn errno.
function classifyCmuxError(err: unknown): CmuxError {
  const e = err as NodeJS.ErrnoException & {
    stdout?: string;
    stderr?: string;
  };
  const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`;

  // execFile couldn't launch the binary at all → cmux isn't installed here.
  if (e.code === "ENOENT") {
    return new CmuxError(
      "cmux-unavailable",
      "cmux is not installed or not on PATH.",
    );
  }
  // cmux accepted the socket connection then dropped it on the ancestry check.
  if (/broken pipe|errno\s*32|connection reset|econnreset/i.test(text)) {
    return new CmuxError(
      "cmux-access-denied",
      'cmux refused the connection (its default "cmux processes only" mode ' +
        "blocks apps not launched from a cmux terminal).",
    );
  }
  // Nothing listening on the socket → cmux isn't running.
  if (
    /no such file|connection refused|econnrefused|could not connect|socket .*not found/i.test(
      text,
    )
  ) {
    return new CmuxError("cmux-unavailable", "cmux does not appear to be running.");
  }
  return new CmuxError(
    "cmux-error",
    (e.stderr || e.stdout || e.message || "cmux command failed").trim(),
  );
}

async function cmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmuxBin(), args, {
      timeout: 10_000,
      // A daemon outside cmux may need the socket password; pass it through if set.
      env: process.env,
    });
    return stdout;
  } catch (err) {
    throw classifyCmuxError(err);
  }
}

// `cmux tree --all` spans every window, workspace, pane, and surface — important
// because per-window listings (list-workspaces) only see the current window, so
// a chat in another window would be missed and wrongly re-spawned.
const SURFACE_LINE_RE = /surface\s+surface:\d+\s+([0-9A-Fa-f-]{36})/g;
const WORKSPACE_LINE_RE = /workspace\s+workspace:\d+\s+([0-9A-Fa-f-]{36})/g;

async function tree(): Promise<string> {
  return cmux(["tree", "--all", "--id-format", "both"]).catch((err) => {
    // An errored tree reads as "no surfaces" downstream → every open chat looks
    // unbound and gets re-spawned. Surface it rather than swallow.
    warn(`tree failed (treating as empty — open chats may be re-spawned): ${errMsg(err)}`);
    return "";
  });
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
  } catch (err) {
    // A transient RPC failure here is indistinguishable from "no binding" to the
    // caller, so it silently turns an open chat into a re-spawn. Log so we can
    // tell a real unbound surface from a flaky lookup.
    warn(`surface.resume.get failed for surface ${short(surfaceUuid)}: ${errMsg(err)}`);
    return null;
  }
}

// The UUID of the surface whose resume binding targets this session, across all
// windows — or null if the chat isn't open anywhere.
async function findSurfaceUuid(sessionId: string): Promise<string | null> {
  const surfaces = matchAll(await tree(), SURFACE_LINE_RE);
  const bindings: Array<{ surface: string; checkpoint: string | null }> = [];
  for (const surface of surfaces) {
    bindings.push({ surface, checkpoint: await checkpointOf(surface) });
  }
  if (cmuxDebug()) {
    const map = bindings
      .map((b) => `${short(b.surface)}→${b.checkpoint ? short(b.checkpoint) : "none"}`)
      .join(", ");
    log(`scan sess=${short(sessionId)} surfaces=[${map}]`);
  }
  const matches = bindings.filter((b) => b.checkpoint === sessionId);
  if (matches.length > 1) {
    // findSurfaceUuid returns the first match; >1 means two surfaces claim the
    // same session — the most likely cause of "focused the wrong/unrelated tab".
    warn(
      `${matches.length} surfaces bind sess=${short(sessionId)} ` +
        `(${matches.map((b) => short(b.surface)).join(", ")}); ` +
        `focusing the first. Likely a stale/duplicate resume binding.`,
    );
  }
  return matches[0]?.surface ?? null;
}

async function workspaceUuids(): Promise<Set<string>> {
  return new Set(matchAll(await tree(), WORKSPACE_LINE_RE));
}

// We tag the workspace that owns a project's chats with this in its cmux
// "description" field, then match on it. Using the description (not the title)
// as the key means the user can rename the workspace and we still find it; and
// a process-only workspace that merely shares the project's cwd has no tag, so
// we never hijack it.
function projectTag(projectId: string): string {
  return `hitch:${projectId}`;
}

// Claude loop runs land in a SEPARATE workspace from the human chat workspace —
// cleaner separation, smaller blast radius, trivial bulk cleanup. Tagged
// distinctly so findProjectWorkspace never consolidates a loop tab into the
// human workspace (or vice-versa). See the Loops PRD.
export function loopsTag(projectId: string): string {
  return `hitch-loops:${projectId}`;
}

interface WsInfo {
  id: string;
  description: string | null;
  index: number;
}

// Every workspace across every window. workspace.list is per-window (like the
// CLI's list-workspaces), so we fan out over window.list — a project workspace
// living in another window would otherwise be missed and wrongly re-created.
async function listAllWorkspaces(): Promise<WsInfo[]> {
  const result: WsInfo[] = [];
  try {
    const windowsOut = await cmux(["rpc", "window.list", "{}"]);
    const windows =
      (JSON.parse(windowsOut) as { windows?: Array<{ id: string }> }).windows ?? [];
    for (const win of windows) {
      try {
        const out = await cmux(["rpc", "workspace.list", JSON.stringify({ window_id: win.id })]);
        const wss =
          (JSON.parse(out) as {
            workspaces?: Array<{ id: string; description?: string | null; index?: number }>;
          }).workspaces ?? [];
        for (const w of wss) {
          result.push({ id: w.id, description: w.description ?? null, index: w.index ?? 0 });
        }
      } catch (err) {
        // Skip a window we can't enumerate rather than failing the whole lookup.
        warn(`workspace.list failed for window ${short(win.id)}: ${errMsg(err)}`);
      }
    }
  } catch (err) {
    // No windows / cmux unreachable → caller falls back to spawning a workspace.
    warn(`window.list failed (project workspace lookup will miss): ${errMsg(err)}`);
  }
  return result;
}

// The UUID of this project's chat workspace, or null if none is tagged yet. If
// several somehow carry the tag (the "lax" case the user is fine with), the
// lowest index wins — that's the most recently active / top-of-list one.
async function findProjectWorkspace(
  projectId: string,
  tag = projectTag(projectId),
): Promise<string | null> {
  const matches = (await listAllWorkspaces()).filter((w) => w.description === tag);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.index - b.index);
  return matches[0].id;
}

// Every surface (tab) UUID inside a given workspace — used for loop-workspace
// reboot recovery (close leftover loop tabs on startup).
async function workspaceSurfaceUuids(workspaceId: string): Promise<string[]> {
  try {
    const out = await cmux([
      "rpc",
      "surface.list",
      JSON.stringify({ workspace_id: workspaceId }),
    ]);
    const surfaces =
      (JSON.parse(out) as { surfaces?: Array<{ id?: string }> }).surfaces ?? [];
    return surfaces.map((s) => s.id).filter((id): id is string => Boolean(id));
  } catch (err) {
    warn(`surface.list failed for workspace ${short(workspaceId)}: ${errMsg(err)}`);
    return [];
  }
}

// Claim a workspace as this project's chat home: give it the project name (an
// explicit name also stops cmux from auto-retitling it per active tab) and the
// hidden tag we match on. Best-effort — an untagged workspace just won't
// consolidate next time; it's never fatal.
async function tagWorkspace(
  workspaceId: string,
  name: string,
  projectId: string,
  tag = projectTag(projectId),
): Promise<void> {
  try {
    await cmux([
      "workspace-action",
      "--workspace",
      workspaceId,
      "--action",
      "rename",
      "--title",
      name,
    ]);
    await cmux([
      "workspace-action",
      "--workspace",
      workspaceId,
      "--action",
      "set-description",
      "--description",
      tag,
    ]);
  } catch {
    // Non-fatal: see above.
  }
}

// Select a surface AND make it the active tab in its workspace. A single
// surface.focus on a tab in a backgrounded workspace only raises the
// workspace — and that switch restores the workspace's previously-active tab,
// clobbering our selection. So we focus once (which raises the workspace and
// tells us its id), explicitly select that workspace, then focus again so the
// tab selection finally sticks.
async function focusSurface(surfaceId: string): Promise<void> {
  const params = JSON.stringify({ surface_id: surfaceId });
  const out = await cmux(["rpc", "surface.focus", params]);
  try {
    const workspaceId = (JSON.parse(out) as { workspace_id?: string }).workspace_id;
    if (workspaceId) {
      await cmux(["select-workspace", "--workspace", workspaceId]);
      await cmux(["rpc", "surface.focus", params]);
    }
  } catch {
    // Best-effort: the first focus already raised the workspace.
  }
}

// Open `command` as a new tab (surface) in an existing workspace. A freshly
// created surface does NOT inherit the workspace's cwd, so the command cd's
// into the project dir itself before launching. `send` types the command and
// the trailing escape submits it — multi-line prompts survive because they're
// single-quoted (the shell reads them via its quote-continuation).
async function addChatTab(workspaceId: string, cwd: string | undefined, command: string): Promise<void> {
  const out = await cmux(["rpc", "surface.create", JSON.stringify({ workspace_id: workspaceId })]);
  const surfaceId = (JSON.parse(out) as { surface_id?: string }).surface_id;
  if (!surfaceId) throw new Error("surface.create returned no surface_id");
  const line = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
  await cmux(["send", "--workspace", workspaceId, "--surface", surfaceId, `${line}\\n`]);
  await focusSurface(surfaceId);
}

export interface PlaceSpec {
  projectId: string;
  projectName: string;
  cwd?: string;
  command: string;
  // Workspace tag to consolidate under + the title to give a freshly-spawned
  // workspace. Default to the project's human-chat workspace; loops override
  // both so their tabs live in a dedicated `<name>-loops` workspace.
  tag?: string;
  workspaceName?: string;
}

// Put a chat into cmux deterministically: as a new tab in this project's
// workspace if one already exists, otherwise as a fresh workspace that we tag
// so every later chat for the project consolidates into it. Returns the UUID of
// the workspace the chat landed in (for the recentSpawns memo), or null.
async function placeChat(spec: PlaceSpec): Promise<string | null> {
  const tag = spec.tag ?? projectTag(spec.projectId);
  const name = spec.workspaceName ?? spec.projectName;
  const existing = await findProjectWorkspace(spec.projectId, tag);
  if (existing) {
    await addChatTab(existing, spec.cwd, spec.command);
    return existing;
  }
  const before = await workspaceUuids();
  const args = ["new-workspace", "--command", spec.command, "--focus", "true"];
  if (spec.cwd) args.push("--cwd", spec.cwd);
  await cmux(args);
  const created = [...(await workspaceUuids())].find((w) => !before.has(w)) ?? null;
  if (created) await tagWorkspace(created, name, spec.projectId, tag);
  return created;
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
  // Identifies the project workspace to consolidate this chat into.
  projectId: string;
  projectName: string;
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
    await focusSurface(uuid);
    await activateApp();
    log(`open sess=${short(spec.sessionId)} → [1] focus existing surface ${short(uuid)}`);
    return "focused";
  }

  // 2. We spawned it moments ago but claude is still booting (no binding yet) →
  //    focus that workspace rather than spawn a duplicate.
  const memo = recentSpawns.get(spec.sessionId);
  if (memo && Date.now() - memo.at < SPAWN_GRACE_MS) {
    try {
      await cmux(["select-workspace", "--workspace", memo.workspace]);
      await activateApp();
      // Workspace-level select only — no specific tab is focused, so cmux keeps
      // whatever tab that workspace had active. Logged because this branch
      // matches the "raised cmux but left the wrong tab focused" symptom.
      log(
        `open sess=${short(spec.sessionId)} → [2] grace: binding not registered yet, ` +
          `selected workspace ${short(memo.workspace)} (no specific tab focused)`,
      );
      return "focused";
    } catch (err) {
      warn(
        `grace select-workspace ${short(memo.workspace)} failed: ${errMsg(err)}; falling through to spawn`,
      );
      recentSpawns.delete(spec.sessionId); // workspace gone; fall through
    }
  }

  // 3. A spawn for this session is mid-flight (concurrent click) → don't race.
  if (spawning.has(spec.sessionId)) {
    await activateApp();
    log(`open sess=${short(spec.sessionId)} → [3] guard: spawn already in flight (no tab focus)`);
    return "focused";
  }

  // 4. Genuinely not open → place it (tab in the project workspace, or a fresh
  //    tagged workspace) and remember where it landed.
  spawning.add(spec.sessionId);
  try {
    const command = spec.command ?? `claude --resume ${spec.sessionId}`;
    const workspace = await placeChat({
      projectId: spec.projectId,
      projectName: spec.projectName,
      cwd: spec.cwd,
      command,
    });
    if (workspace) {
      recentSpawns.set(spec.sessionId, { workspace, at: Date.now() });
    }
    await activateApp();
    log(
      `open sess=${short(spec.sessionId)} → [4] spawn: not open anywhere, ` +
        `placed in workspace ${workspace ? short(workspace) : "?"}`,
    );
    return "spawned";
  } finally {
    spawning.delete(spec.sessionId);
  }
}

export interface StartSpec {
  taskKey: string; // dedup key for fresh task spawns, e.g. "tasks/slug"
  prompt: string;
  sessionId: string; // pinned via `claude --session-id`, so we know it up front
  cwd?: string;
  model?: string; // `claude --model` (e.g. "claude-opus-4-8"); omit for the default
  effort?: string; // `claude --effort` (low|medium|high|xhigh|max); omit for the default
  // Identifies the project workspace to consolidate this chat into.
  projectId: string;
  projectName: string;
}

// Launch a BRAND-NEW Claude Code session seeded with `prompt`, in a fresh cmux
// workspace. The prompt rides as claude's positional argument — NOT `-p` — so it
// stays an interactive session on subscription auth (the user drives it); claude
// just submits it as the first turn. We pin the session id with `--session-id`,
// so the daemon already linked the task before this spawn (no agent
// introspection needed) and openChat() can resume by that same id later. Dedup
// still keys on the task: a second click within the grace window focuses the
// workspace we just made instead of spawning a duplicate.
//
// Unlike openChat, we deliberately do NOT activateApp() here: starting a task is
// a fire-and-forget delegation, and raising cmux to the OS foreground every time
// just makes the user cmd-tab back to hitch. The chat still lands in cmux (and is
// selected in-app); the user pulls it forward later via the "open" button, which
// routes through openChat and does raise the app.
export async function startChat(spec: StartSpec): Promise<OpenResult> {
  // We spawned for this task moments ago (agent may still be booting) → don't
  // spawn a duplicate. Select the workspace in-app, but stay in the background.
  const memo = recentSpawns.get(spec.taskKey);
  if (memo && Date.now() - memo.at < SPAWN_GRACE_MS) {
    try {
      await cmux(["select-workspace", "--workspace", memo.workspace]);
      return "focused";
    } catch {
      recentSpawns.delete(spec.taskKey); // workspace gone; fall through
    }
  }

  // A spawn for this task is mid-flight (concurrent click) → don't race.
  if (spawning.has(spec.taskKey)) {
    return "focused";
  }

  spawning.add(spec.taskKey);
  try {
    // Optional kickoff flags. Values come from a fixed allowlist in the UI
    // (model ids / effort levels), so they need no shell-quoting.
    const flags: string[] = [];
    if (spec.model) flags.push("--model", spec.model);
    if (spec.effort) flags.push("--effort", spec.effort);
    const flagStr = flags.length ? `${flags.join(" ")} ` : "";
    const command = `claude --session-id ${spec.sessionId} ${flagStr}${shellQuote(spec.prompt)}`;
    const workspace = await placeChat({
      projectId: spec.projectId,
      projectName: spec.projectName,
      cwd: spec.cwd,
      command,
    });
    if (workspace) {
      recentSpawns.set(spec.taskKey, { workspace, at: Date.now() });
    }
    return "spawned";
  } finally {
    spawning.delete(spec.taskKey);
  }
}

export interface StartLoopSpec {
  loopPath: string; // dedup/identity key, e.g. "loops/pr-review"
  prompt: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  effort?: string;
  projectId: string;
  projectName: string;
}

// Launch a BRAND-NEW Claude loop run in the project's dedicated
// `<projectName>-loops` cmux workspace, with permissions bypassed (an
// unattended run can't answer a permission prompt — that would read as
// needs-input and end the run early). Like startChat: positional prompt (NOT
// -p, so it stays on subscription auth), pinned --session-id. Returns where it
// landed. The daemon watches the session marker for done, then closeSurface()s.
export async function startLoopChat(spec: StartLoopSpec): Promise<OpenResult> {
  const flags: string[] = ["--permission-mode", "bypassPermissions"];
  if (spec.model) flags.push("--model", spec.model);
  if (spec.effort) flags.push("--effort", spec.effort);
  const command = `claude --session-id ${spec.sessionId} ${flags.join(" ")} ${shellQuote(spec.prompt)}`;
  await placeChat({
    projectId: spec.projectId,
    projectName: spec.projectName,
    cwd: spec.cwd,
    command,
    tag: loopsTag(spec.projectId),
    workspaceName: `${spec.projectName}-loops`,
  });
  return "spawned";
}

// Close the cmux surface (tab) bound to a session — reaps its child `claude`
// process. Used to tear a finished loop run's tab down. Returns true if a
// surface was found and closed. "Open chat" later still works: it re-spawns from
// the on-disk transcript via openChat.
export async function closeSurface(sessionId: string): Promise<boolean> {
  const uuid = await findSurfaceUuid(sessionId);
  if (!uuid) return false;
  try {
    await cmux(["close-surface", "--surface", uuid]);
    log(`closed surface ${short(uuid)} for sess=${short(sessionId)}`);
    return true;
  } catch (err) {
    warn(`close-surface failed for ${short(uuid)}: ${errMsg(err)}`);
    return false;
  }
}

// Reboot recovery: close every leftover tab in this project's loops workspace.
// In-memory active-run state is lost on daemon restart, so orphaned loop tabs
// (and their idle claude processes) must be reaped on startup. Best-effort.
export async function closeLoopWorkspaceSurfaces(
  projectId: string,
): Promise<number> {
  const workspace = await findProjectWorkspace(projectId, loopsTag(projectId));
  if (!workspace) return 0;
  const surfaces = await workspaceSurfaceUuids(workspace);
  let closed = 0;
  for (const surface of surfaces) {
    try {
      await cmux(["close-surface", "--surface", surface]);
      closed++;
    } catch (err) {
      warn(`reboot close-surface ${short(surface)} failed: ${errMsg(err)}`);
    }
  }
  if (closed) log(`reboot recovery: closed ${closed} leftover loop surface(s)`);
  return closed;
}

// Single-quote an arbitrary (possibly multi-line) string for sh, so the seed
// prompt survives intact as one argument when cmux runs `--command` via a shell.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
