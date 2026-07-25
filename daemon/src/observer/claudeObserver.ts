// Claude sensing. THE PRIMARY SENSOR is `~/.claude/sessions/*.json` — Claude's
// own pidfiles. Verified shape on a real machine (2026-07-25):
//
//   { pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint,
//     name, status, updatedAt, statusUpdatedAt }
//
// One file read per session gives us all three things we need at once:
// existence (pid), process identity (pid + procStart) and activity (`status` is
// Claude's own self-report). `claude agents --json` returns the same data but
// costs ~190 ms per invocation, so it is a FALLBACK ONLY — never called per
// tick (see `claudeAgentsFallback`).
//
// Environment-blind (§4): no imports from launchers/ or cmux.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { commandIsHarness, isPidAlive, type ProcessInfo } from "./liveness.js";
import type { ObservedActivity } from "./types.js";

const execFileP = promisify(execFile);

// CLAUDE_CONFIG_DIR relocates ~/.claude (also the XDG ~/.config/claude path). We
// honor the env var so a relocated store is still observed; absent → default.
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

export function sessionsDir(): string {
  return join(claudeHome(), "sessions");
}

function projectsDir(): string {
  return join(claudeHome(), "projects");
}

// Find a session's transcript by globbing `~/.claude/projects/*/<sessionId>.jsonl`
// — the filename IS the session id. We do NOT reconstruct the directory from the
// cwd: Claude's cwd→dir munge replaces every non-`[A-Za-z0-9-]` char with `-`
// (underscores, spaces, dots…), so it's lossy and collision-prone and must never
// be reversed/recreated for lookup. Returns the first match, or null when the
// transcript isn't on this disk (ran on another host, or persistence disabled).
export function findClaudeTranscript(sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectsDir());
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(projectsDir(), entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ClaudePidfile {
  pid: number;
  sessionId: string;
  cwd: string;
  /** `procStart` parsed to epoch ms — the start-time half of process identity. */
  startedAt: number | null;
  procStart: string | null;
  status: string | null; // self-reported "busy" | "idle" (v2.1.196+); null on vscode
  entrypoint: string | null;
  kind: string | null;
  name: string | null;
}

export interface ClaudeSession extends ClaudePidfile {
  alive: boolean;
}

function parseStartedAt(raw: unknown, procStart: string | null): number | null {
  // The pidfile carries both `startedAt` (already epoch ms on current CLIs) and
  // `procStart` (an ISO/date string). Prefer the number; fall back to parsing.
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  if (procStart) {
    const parsed = Date.parse(procStart);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readClaudePidfiles(): ClaudePidfile[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const out: ClaudePidfile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(sessionsDir(), name), "utf8")) as Record<
        string,
        unknown
      >;
      const pid = typeof raw.pid === "number" ? raw.pid : Number(raw.pid);
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
      if (!Number.isInteger(pid) || !sessionId) continue;
      const procStart = typeof raw.procStart === "string" ? raw.procStart : null;
      out.push({
        pid,
        sessionId,
        cwd: typeof raw.cwd === "string" ? raw.cwd : "",
        startedAt: parseStartedAt(raw.startedAt, procStart),
        procStart,
        status: typeof raw.status === "string" ? raw.status : null,
        entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : null,
        kind: typeof raw.kind === "string" ? raw.kind : null,
        name: typeof raw.name === "string" ? raw.name : null,
      });
    } catch {
      // unreadable/stale pidfile — skip
    }
  }
  return out;
}

// The supported front door. ~190 ms per call, so it is NEVER on the tick path:
// the observer calls it at most once a minute, and only when the pidfile
// directory yielded nothing (an older CLI that doesn't write pidfiles at all).
export async function claudeAgentsFallback(): Promise<ClaudePidfile[]> {
  try {
    const { stdout } = await execFileP("claude", ["agents", "--json"], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ClaudePidfile[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const pid = typeof e.pid === "number" ? e.pid : Number(e.pid);
      const sessionId = typeof e.sessionId === "string" ? e.sessionId : null;
      if (!Number.isInteger(pid) || !sessionId) continue;
      out.push({
        pid,
        sessionId,
        cwd: typeof e.cwd === "string" ? e.cwd : "",
        startedAt: parseStartedAt(e.startedAt, null),
        procStart: null,
        status: typeof e.status === "string" ? e.status : null,
        entrypoint: null,
        kind: null,
        name: typeof e.name === "string" ? e.name : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Decide whether a pidfile's pid is still the process that owns `sessionId`.
// Timezone-proof PID-reuse guard (the pidfile's `procStart` is UTC while
// `ps -o lstart` is local, so a string compare is wrong): instead we read the
// live process's argv. Claude launches carry `--session-id <uuid>`, so:
//   - argv names this session id  → it's our process, alive.
//   - argv names a *different* session id → the pid was reused, dead.
//   - argv is a claude binary with no visible id → trust the pidfile, alive.
//   - argv is not claude at all → reused to something unrelated, dead.
//   - pid not in the snapshot but kill(0) says alive → don't over-reject, alive.
export function pidOwnsSession(command: string | undefined, sessionId: string): boolean {
  if (command === undefined) return true; // alive per kill(0), just not in the snapshot
  if (command.toLowerCase().includes(sessionId.toLowerCase())) return true;
  const flagged = command.match(/--session-id[= ]([0-9a-f-]{36})/i);
  if (flagged && flagged[1].toLowerCase() !== sessionId.toLowerCase()) {
    return false; // argv pins a different session → reused
  }
  return commandIsHarness(command, "claude-code");
}

// Every Claude session the pidfiles know about, marked live or not. Pidfiles
// linger after a crash, so "has a pidfile" is NOT existence — the pid must pass
// kill(0) AND still own the session.
export function discoverClaudeSessions(
  processes: ProcessInfo[],
  pidfiles: ClaudePidfile[] = readClaudePidfiles(),
): ClaudeSession[] {
  const byPid = new Map(processes.map((p) => [p.pid, p.command] as const));
  const bySession = new Map<string, ClaudePidfile>();
  for (const file of pidfiles) {
    // Two pidfiles for one session (a stale one plus the live one): the live pid
    // wins.
    const existing = bySession.get(file.sessionId);
    if (existing && isPidAlive(existing.pid) && !isPidAlive(file.pid)) continue;
    bySession.set(file.sessionId, file);
  }
  const sessions: ClaudeSession[] = [];
  for (const file of bySession.values()) {
    const alive = isPidAlive(file.pid) && pidOwnsSession(byPid.get(file.pid), file.sessionId);
    sessions.push({ ...file, alive });
  }
  return sessions;
}

export interface ClaudeTranscript {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

// Dormant discovery: transcripts touched inside the recency window with no live
// process. One readdir per project dir plus a stat per file — cheap, but not
// cheap enough for the 1 s active cadence, so the observer rate-limits it.
// Newest first, hard-capped.
export function scanClaudeTranscripts(sinceMs: number, limit = 200): ClaudeTranscript[] {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir());
  } catch {
    return [];
  }
  const out: ClaudeTranscript[] = [];
  for (const dir of dirs) {
    const full = join(projectsDir(), dir);
    let names: string[];
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(full, name);
      try {
        const st = statSync(path);
        if (st.mtimeMs < sinceMs) continue;
        out.push({
          sessionId: name.slice(0, -".jsonl".length),
          path,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // vanished mid-scan — ignore
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

// A dormant chat still needs a cwd to attach to a project. Claude stamps `cwd`
// on every transcript line, so the FIRST line is enough — one bounded read,
// cached by the caller (a transcript's cwd never changes).
export function claudeTranscriptCwd(path: string, maxBytes = 16 * 1024): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").slice(0, maxBytes);
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.cwd === "string" && obj.cwd.trim()) return obj.cwd.trim();
    } catch {
      // partial trailing line, or a non-JSON line — keep looking
    }
  }
  return null;
}

// Map the pidfile self-reported `status` to our activity axis. This is the
// harness's own truth and the primary Claude signal where present; "busy" is
// mid-turn, "idle" is waiting-for-user. Anything else (incl. vscode's null)
// → unknown, so the caller falls back to the transcript tail.
export function activityFromPidfileStatus(status: string | null): ObservedActivity {
  if (status === "busy") return "working";
  if (status === "idle") return "idle";
  return "unknown";
}

const IDLE_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

// Fallback activity derivation from the transcript tail, per the doc's rules:
// the last user/assistant line decides. An assistant line whose turn closed
// (`end_turn`) is idle; an open `tool_use` (or a still-streaming assistant, or a
// trailing user/tool_result line) is working. Trailing metadata lines
// (ai-title/mode/permission-mode) are ignored. `unknown` when no message line is
// in the tail window.
export function deriveClaudeTranscriptActivity(lines: string[]): {
  activity: ObservedActivity;
  lastStopReason: string | null;
} {
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "assistant") {
      const message = obj.message as { stop_reason?: unknown } | undefined;
      const stopReason = typeof message?.stop_reason === "string" ? message.stop_reason : null;
      if (stopReason && IDLE_STOP_REASONS.has(stopReason)) {
        return { activity: "idle", lastStopReason: stopReason };
      }
      return { activity: "working", lastStopReason: stopReason };
    }
    if (obj.type === "user") {
      // A new user prompt or a returning tool_result: the model resumes → working.
      return { activity: "working", lastStopReason: null };
    }
  }
  return { activity: "unknown", lastStopReason: null };
}
