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

export type LoopDoneReason = "waiting" | "needs-input" | "ended" | "timed-out";

interface SessionMarker {
  status?: string;
}

// Watch the per-session marker until the loop's first turn settles. The global
// Claude hook writes working → waiting (turn done, idle) / needs-input (blocked
// asking — unattended, nobody answers, so terminal), or removes the file on
// SessionEnd. Resolves with the terminal reason, or "timed-out" after
// timeoutMs. Polls on an interval; never rejects.
export function watchSessionMarker(
  markerDir: string,
  sessionId: string,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<LoopDoneReason> {
  const markerPath = join(markerDir, `${sessionId}.json`);
  const pollMs = opts.pollMs ?? 2500;
  const deadline = Date.now() + opts.timeoutMs;
  return new Promise((resolveDone) => {
    let seen = false; // marker has appeared at least once
    let timer: NodeJS.Timeout;
    const tick = async () => {
      if (Date.now() >= deadline) {
        resolveDone("timed-out");
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
      // SessionEnd removed the marker after we'd seen it → the session ended.
      if (seen && !exists) {
        resolveDone("ended");
        return;
      }
      if (marker?.status === "waiting") {
        resolveDone("waiting");
        return;
      }
      if (marker?.status === "needs-input") {
        resolveDone("needs-input");
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    void timer;
  });
}
