import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  command: string;
}

// kill(pid, 0): probes existence without signalling. ESRCH = dead; EPERM =
// alive but owned by another user. Same liveness primitive the daemon already
// uses for chat-pid healing.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The process's wall-clock start time as `ps -o lstart` prints it
// (e.g. "Tue Jun 30 12:56:19 2026"). This string is exactly the format Claude
// writes into a pidfile's `procStart`, so a direct compare guards against PID
// reuse: a recycled PID is a different process with a different start time.
export async function processStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// Snapshot every process's full command line in one `ps` call (cheap, ~one per
// reconcile tick). Used to verify a Claude PID is still a `claude` binary and to
// enumerate live `codex` processes. `-ww` disables column truncation so long
// argv survives.
export async function snapshotProcesses(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileP("ps", ["-axww", "-o", "pid=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const out: ProcessInfo[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      out.push({ pid: Number(match[1]), command: match[2] });
    }
    return out;
  } catch {
    return [];
  }
}

// True when the live PID is still a process whose command names the harness
// binary — rejects a recycled PID now owned by something unrelated. `claude` is
// a compiled native binary (not node), so we match the binary path/name, never
// `pgrep -f node`. `Claude.app` (the desktop app) is excluded so its helper
// processes don't read as CLI sessions.
export function commandIsHarness(command: string, harness: string): boolean {
  if (!command) return false;
  if (harness === "codex") {
    return /(^|\/)codex(\s|$)/.test(command) || command.includes("codex ");
  }
  if (command.includes("Claude.app")) return false;
  return /(^|\/)claude(\s|$)/.test(command) || command.includes("/claude");
}

// Live `codex` processes, excluding the shared app-server, the macOS computer-use
// helper, and schema/debug subcommands — none of which are a per-chat TUI. This
// is corroboration for the rollout-file signal, not chat identity: a TUI chat
// has its own `codex`/`codex resume <id>` process, but app-server clients share
// one server across many threads.
export function codexTuiProcesses(processes: ProcessInfo[]): ProcessInfo[] {
  return processes.filter((p) => {
    const c = p.command;
    if (!commandIsHarness(c, "codex")) return false;
    if (c.includes("app-server")) return false;
    if (c.includes("Computer Use")) return false;
    if (c.includes("generate-ts") || c.includes("--schema")) return false;
    return true;
  });
}

// Parse a Codex `resume <uuid>` from a TUI process command, when present — the
// one case where a live process names its thread id directly.
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function codexResumeThreadId(command: string): string | null {
  if (!/\bresume\b/.test(command)) return null;
  const match = command.match(UUID_RE);
  return match ? match[0].toLowerCase() : null;
}
