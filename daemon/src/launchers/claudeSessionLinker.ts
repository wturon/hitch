// Harness-level session discovery for Claude Code. Some environments (the VS Code
// / Cursor extensions) own the session id and launch fire-and-forget, so we can't
// pin or receive the id at launch the way cmux does. Instead the launcher records
// a *claim* ("a new claude session is coming for repo C, task T") and this module
// watches Claude's canonical session store to bind the next new session to it.
//
// Claude writes every session — regardless of which environment launched it — to
// ~/.claude/projects/<munged-cwd>/<session-id>.jsonl, where the filename IS the id
// (verified empirically). So one cheap, always-on watcher serves every
// fire-and-forget Claude environment; this is a harness concern, not a per-env one.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import type { LauncherLogger } from "./types.js";

export interface ClaudeClaim {
  cwd: string; // the repo working directory the session will run in
  taskPath: string; // rel task path, used only as a same-cwd tiebreaker
  since: number; // epoch ms; only sessions appearing after this can match
  onLink: (sessionId: string) => Promise<void>;
}

// A claim is abandoned if the user never actually starts the pre-filled chat.
const CLAIM_TTL_MS = 30 * 60_000;

const claims: ClaudeClaim[] = [];
let watcher: FSWatcher | null = null;
let log: LauncherLogger | null = null;

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function projectsDir(): string {
  return join(claudeHome(), "projects");
}

// Claude munges the cwd into the project dir name by replacing both "/" and "."
// with "-" (e.g. /Users/x/code/hitch → -Users-x-code-hitch). We only ever munge
// our own known cwds and compare — never reverse it (it isn't reversible).
export function mungeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

function prune(now: number): void {
  for (let i = claims.length - 1; i >= 0; i--) {
    if (now - claims[i].since >= CLAIM_TTL_MS) claims.splice(i, 1);
  }
}

// A new <id>.jsonl appeared. Bind it to the best matching open claim (same munged
// cwd). With >1 claim for a cwd, disambiguate by which task path appears in the
// freshly written transcript; otherwise the oldest claim wins.
async function onNewSession(filePath: string): Promise<void> {
  const dirName = basename(dirname(filePath));
  const sessionId = basename(filePath, ".jsonl");
  const now = Date.now();
  prune(now);

  const matching = claims.filter((c) => mungeCwd(c.cwd) === dirName);
  if (matching.length === 0) return;

  let chosen = matching.slice().sort((a, b) => a.since - b.since)[0];
  if (matching.length > 1) {
    try {
      const text = readFileSync(filePath, "utf8");
      const byPrompt = matching.find((c) => text.includes(c.taskPath));
      if (byPrompt) chosen = byPrompt;
    } catch {
      // fall back to oldest
    }
  }

  const idx = claims.indexOf(chosen);
  if (idx >= 0) claims.splice(idx, 1);

  try {
    await chosen.onLink(sessionId);
    log?.info(
      `[hitch] linked claude session ${sessionId} → ${chosen.taskPath} (via session-store discovery)`,
    );
  } catch (err) {
    log?.error?.(`[hitch] failed to link discovered session ${sessionId}: ${String(err)}`);
  }
}

function ensureWatcher(): void {
  if (watcher) return;
  // depth 1 keeps us to <munged-cwd>/<id>.jsonl and excludes the sibling <id>/
  // sub-transcript directories. We react to `add` only — `change` fires on every
  // appended message, which we don't care about.
  watcher = chokidar.watch(projectsDir(), { ignoreInitial: true, depth: 1 });
  watcher.on("add", (path) => {
    if (!path.endsWith(".jsonl")) return;
    // Only top-level files directly under a project dir (parent's parent is the
    // projects root), never files nested inside an <id>/ subdirectory.
    if (dirname(dirname(path)) !== projectsDir()) return;
    void onNewSession(path);
  });
  watcher.on("error", (err) =>
    log?.error?.(`[hitch] claude session watcher error: ${String(err)}`),
  );
}

// Register intent to link the next new Claude session for `cwd`. Lazily starts the
// watcher on first use (zero cost until a fire-and-forget env is actually used).
// One open claim per cwd — a second start supersedes the first.
export function registerClaudeClaim(
  claim: ClaudeClaim,
  logger: LauncherLogger,
): void {
  log = logger;
  ensureWatcher();
  for (let i = claims.length - 1; i >= 0; i--) {
    if (claims[i].cwd === claim.cwd) claims.splice(i, 1);
  }
  claims.push(claim);
}

export async function stopClaudeSessionLinker(): Promise<void> {
  claims.length = 0;
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}
