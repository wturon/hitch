import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  claudeTranscriptPath,
  mungeCwd,
} from "../launchers/claudeSessionLinker.js";
import { commandIsHarness, isPidAlive, type ProcessInfo } from "./liveness.js";
import type { ObservedActivity } from "./types.js";

const execFileP = promisify(execFile);

// CLAUDE_CONFIG_DIR relocates ~/.claude (also the XDG ~/.config/claude path). We
// honor the env var so a relocated store is still observed; absent → default.
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function sessionsDir(): string {
  return join(claudeHome(), "sessions");
}

export interface ClaudePidfile {
  pid: number;
  sessionId: string;
  cwd: string;
  procStart: string | null;
  status: string | null; // self-reported "busy" | "idle" (v2.1.196+); null on vscode
  entrypoint: string | null;
  kind: string | null;
  name: string | null;
}

export interface ClaudeSession extends ClaudePidfile {
  alive: boolean;
}

function readPidfiles(): ClaudePidfile[] {
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
      const raw = JSON.parse(
        readFileSync(join(sessionsDir(), name), "utf8"),
      ) as Record<string, unknown>;
      const pid = typeof raw.pid === "number" ? raw.pid : Number(raw.pid);
      const sessionId =
        typeof raw.sessionId === "string" ? raw.sessionId : null;
      if (!Number.isInteger(pid) || !sessionId) continue;
      out.push({
        pid,
        sessionId,
        cwd: typeof raw.cwd === "string" ? raw.cwd : "",
        procStart: typeof raw.procStart === "string" ? raw.procStart : null,
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

// The supported front door (`claude agents --json`) — same running set as the
// pidfiles, but it's the documented interface so we union it in to catch any
// session whose raw pidfile we couldn't read. Returns [] if the binary or
// subcommand isn't available (older CLI), leaving pidfiles as the sole source.
async function claudeAgents(): Promise<
  Array<{ pid: number; sessionId: string; cwd: string; status: string | null }>
> {
  try {
    const { stdout } = await execFileP("claude", ["agents", "--json"], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out = [];
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
        status: typeof e.status === "string" ? e.status : null,
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
function pidOwnsSession(
  command: string | undefined,
  sessionId: string,
): boolean {
  if (command === undefined) return true; // alive per kill(0), just not in the snapshot
  if (command.toLowerCase().includes(sessionId.toLowerCase())) return true;
  const flagged = command.match(/--session-id[= ]([0-9a-f-]{36})/i);
  if (flagged && flagged[1].toLowerCase() !== sessionId.toLowerCase()) {
    return false; // argv pins a different session → reused
  }
  return commandIsHarness(command, "claude-code");
}

// Discover every Claude session the machine knows about and mark which are live.
// `claude agents --json` is the authoritative live set (the supported front door
// runs its own liveness); pidfiles enrich it with status/entrypoint and cover any
// session the front door missed. A pidfile-only session is live when its pid
// passes kill(0) AND still owns the session (see `pidOwnsSession`).
export async function discoverClaudeSessions(
  processes: ProcessInfo[],
): Promise<ClaudeSession[]> {
  const byPid = new Map(processes.map((p) => [p.pid, p.command] as const));
  const pidfiles = readPidfiles();
  const bySession = new Map<string, ClaudePidfile>();
  for (const file of pidfiles) bySession.set(file.sessionId, file);

  const agentsLive = new Set<string>();
  for (const agent of await claudeAgents()) {
    agentsLive.add(agent.sessionId);
    const existing = bySession.get(agent.sessionId);
    if (existing) {
      if (existing.status === null && agent.status !== null) {
        existing.status = agent.status;
      }
      continue;
    }
    bySession.set(agent.sessionId, {
      pid: agent.pid,
      sessionId: agent.sessionId,
      cwd: agent.cwd,
      procStart: null,
      status: agent.status,
      entrypoint: null,
      kind: null,
      name: null,
    });
  }

  const sessions: ClaudeSession[] = [];
  for (const file of bySession.values()) {
    const alive =
      agentsLive.has(file.sessionId) ||
      (isPidAlive(file.pid) &&
        pidOwnsSession(byPid.get(file.pid), file.sessionId));
    sessions.push({ ...file, alive });
  }
  return sessions;
}

// Map the pidfile/agents self-reported `status` to our activity axis. This is
// the harness's own truth and the primary Claude signal where present; "busy"
// is mid-turn, "idle" is waiting-for-user. Anything else (incl. vscode's null)
// → unknown, so the caller falls back to the transcript tail.
export function activityFromPidfileStatus(
  status: string | null,
): ObservedActivity {
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
      const stopReason =
        typeof message?.stop_reason === "string" ? message.stop_reason : null;
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

export { claudeTranscriptPath, mungeCwd, claudeHome, sessionsDir };
