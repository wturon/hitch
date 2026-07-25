import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  command: string;
  /** Kernel start time as epoch ms, from `ps -o lstart`. null when unparseable. */
  startedAt: number | null;
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

// PID-reuse check on the start-time half of process identity. Deliberately
// LENIENT: clock skew between how a harness records its own start and how `ps`
// reports it is measured in seconds, while a recycled pid is a process that
// started much later. So we only call it a mismatch when the two disagree by
// more than `toleranceMs` (default 5 min). Unknown on either side → no opinion
// (true), and the argv check stays the sharp instrument.
export function startTimesAgree(
  recorded: number | null,
  observed: number | null,
  toleranceMs = 5 * 60_000,
): boolean {
  if (recorded === null || observed === null) return true;
  return Math.abs(recorded - observed) <= toleranceMs;
}

// `ps -o lstart=` prints e.g. "Fri Jul 25 09:14:02 2026" (local time, day may be
// space-padded). Anchored so a command line that happens to start with a date
// can't be mistaken for one.
const PS_LINE =
  /^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

// Snapshot every process's command line AND start time in one `ps` call (cheap,
// ~one per tick). The start time is the second half of process identity:
// (pid, start-time) is what makes PID reuse detectable. `-ww` disables column
// truncation so long argv survives. A line whose lstart doesn't parse degrades
// to command-only rather than being dropped.
export async function snapshotProcesses(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileP("ps", ["-axww", "-o", "pid=,lstart=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const out: ProcessInfo[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const full = trimmed.match(PS_LINE);
      if (full) {
        const started = Date.parse(full[2].replace(/\s+/g, " "));
        out.push({
          pid: Number(full[1]),
          command: full[3],
          startedAt: Number.isFinite(started) ? started : null,
        });
        continue;
      }
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      out.push({ pid: Number(match[1]), command: match[2], startedAt: null });
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
