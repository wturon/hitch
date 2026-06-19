// Claude loop-run lifecycle helpers: locate/read the on-disk session transcript
// (for the zero-API-cost summary) and watch the per-session status marker the
// global Claude hook writes (for done-detection, since loop runs have no
// task.md). See the Loops PRD "Run summary, with zero API cost" and
// "Done detection: the Stop hook".

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code stores each session transcript at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, where <encoded-cwd> is the
// absolute cwd with every non-alphanumeric char replaced by "-" (so a leading
// "/" becomes a leading "-"). ASSUMPTION verified against observed paths like
// "-Users-willturon-code-hitch"; if Claude changes the scheme, only the summary
// (a nicety) is affected — the run still completes.
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

// The final assistant text message from a transcript, capped. Reads the JSONL
// from the end, pulling the last entry that is an assistant message with text
// content. Tolerant of format drift: any parse failure just yields null.
export async function readTranscriptSummary(
  path: string,
  cap = 1000,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = assistantText(entry);
    if (text) return text.length > cap ? `${text.slice(0, cap)}…` : text;
  }
  return null;
}

function assistantText(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== "assistant") return null;
  const message = e.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

export type LoopDoneReason =
  | "waiting"
  | "needs-input"
  | "ended"
  | "idle" // hook-independent fallback: transcript went quiet
  | "timed-out";

export interface LoopDoneResult {
  reason: LoopDoneReason;
  // The agent's pid as last reported by the hook marker, so teardown can
  // SIGKILL as a fallback if closeSurface can't find the cmux surface.
  pid: number | null;
}

interface SessionMarker {
  status?: string;
  pid?: number | null;
}

// Watch a loop's Claude session until its first turn settles, then return how it
// ended + the agent pid (for teardown fallback). Primary signal: the per-session
// marker the global Claude hook writes (working → waiting/needs-input, removed on
// SessionEnd). FALLBACK when the hook isn't installed (no marker ever appears):
// the on-disk transcript going quiet (mtime stable for `idleMs` with content) is
// treated as `idle` — so done-detection doesn't hard-depend on the hook and a
// loop needn't burn its full `timeoutMinutes`. Resolves "timed-out" past the
// deadline. Polls on an interval; never rejects.
export function watchSessionMarker(
  markerDir: string,
  sessionId: string,
  opts: {
    timeoutMs: number;
    pollMs?: number;
    transcriptPath?: string;
    idleMs?: number;
  },
): Promise<LoopDoneResult> {
  const markerPath = join(markerDir, `${sessionId}.json`);
  const pollMs = opts.pollMs ?? 2500;
  const idleMs = opts.idleMs ?? 45_000;
  const deadline = Date.now() + opts.timeoutMs;
  return new Promise((resolveDone) => {
    let seen = false; // marker has appeared at least once
    let lastPid: number | null = null;
    let timer: NodeJS.Timeout;
    const done = (reason: LoopDoneReason) => resolveDone({ reason, pid: lastPid });
    const tick = async () => {
      if (Date.now() >= deadline) {
        done("timed-out");
        return;
      }
      let marker: SessionMarker | null = null;
      let exists = false;
      try {
        await stat(markerPath);
        exists = true;
        marker = JSON.parse(await readFile(markerPath, "utf8")) as SessionMarker;
      } catch {
        marker = null;
      }
      if (exists) seen = true;
      if (typeof marker?.pid === "number") lastPid = marker.pid;
      // SessionEnd removed the marker after we'd seen it → the session ended.
      if (seen && !exists) {
        done("ended");
        return;
      }
      if (marker?.status === "waiting") {
        done("waiting");
        return;
      }
      if (marker?.status === "needs-input") {
        done("needs-input");
        return;
      }
      // Hook-independent fallback: only when the marker has NEVER appeared (hook
      // not installed). A quiescent transcript with content = the turn ended.
      if (!seen && opts.transcriptPath) {
        try {
          const st = await stat(opts.transcriptPath);
          if (st.size > 0 && Date.now() - st.mtimeMs >= idleMs) {
            done("idle");
            return;
          }
        } catch {
          // transcript not there yet — keep waiting
        }
      }
      timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    void timer;
  });
}
