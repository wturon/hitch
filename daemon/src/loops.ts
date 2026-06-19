// Daemon-side loop machinery: scan on-disk loop definitions, evaluate the
// 5-field cron schedule (local tz, 1-min granularity), and run the optional
// trigger.sh gate. Kept dependency-free and self-contained; the renderer has a
// parallel cron engine in desktop/src/renderer/lib/loops.ts — keep them in step.

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ScannedLoop {
  slug: string;
  loopPath: string; // "loops/<slug>" — matches loopRuns.loopPath
  title: string;
  schedule: string; // 5-field cron
  harness: string; // "claude-code" | "codex"
  model?: string;
  reasoning?: string;
  timeoutMinutes?: number;
  concurrency: string;
  prompt: string; // index.md body
  triggerRelPath: string | null; // "loops/<slug>/trigger.sh" if present
  triggerAbsPath: string | null;
  content: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseLoopFile(content: string): {
  fm: Record<string, string>;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    fm[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { fm, body: match[2] };
}

// Read every loop definition under <hitchPath>/loops/<slug>/index.md, noting a
// sibling trigger.sh when present.
export async function scanLoops(hitchPath: string): Promise<ScannedLoop[]> {
  const loopsDir = join(hitchPath, "loops");
  let entries;
  try {
    entries = await readdir(loopsDir, { withFileTypes: true });
  } catch {
    return []; // no loops dir yet
  }
  const out: ScannedLoop[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const indexAbs = join(loopsDir, slug, "index.md");
    let content: string;
    try {
      content = await readFile(indexAbs, "utf8");
    } catch {
      continue; // dir without an index.md isn't a loop
    }
    const { fm, body } = parseLoopFile(content);
    const triggerAbs = join(loopsDir, slug, "trigger.sh");
    let hasTrigger = false;
    try {
      hasTrigger = (await stat(triggerAbs)).isFile();
    } catch {
      hasTrigger = false;
    }
    const timeout = Number(fm.timeoutMinutes);
    out.push({
      slug,
      loopPath: `loops/${slug}`,
      title: fm.title || slug,
      schedule: fm.schedule || "*/30 * * * *",
      harness: fm.harness === "codex" ? "codex" : "claude-code",
      model: fm.model || undefined,
      reasoning: fm.reasoning || undefined,
      timeoutMinutes:
        Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      concurrency: fm.concurrency || "skip",
      prompt: body,
      triggerRelPath: hasTrigger ? `loops/${slug}/trigger.sh` : null,
      triggerAbsPath: hasTrigger ? triggerAbs : null,
      content,
    });
  }
  return out;
}

// ───────────────────────────── cron ─────────────────────────────────────────

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      step = Number(part.slice(slash + 1));
      range = part.slice(0, slash);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const dash = range.indexOf("-");
      if (dash !== -1) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = hi = Number(range);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  // DoW accepts 0-7 (both 0 and 7 = Sunday). Parse over [0,7] so ranges/steps
  // containing 7 (e.g. `1-7`, `*/7`) survive, then fold a standalone 7 → 0.
  // (A blanket `replace(/7/g,"0")` corrupts `1-7`→`1-0`, `*/7`→`*/0`, `17`→`10`.)
  const dow = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) {
    dow.add(0);
    dow.delete(7);
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function matchesDay(spec: CronSpec, t: Date): boolean {
  const domOk = spec.dom.has(t.getDate());
  const dowOk = spec.dow.has(t.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

// Next fire time strictly after `after` (next whole minute onward). Local tz,
// no catch-up. null if invalid or nothing within a year.
export function cronNextRun(expr: string, after: Date): Date | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const cap = new Date(t.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (t < cap) {
    if (
      spec.month.has(t.getMonth() + 1) &&
      spec.hour.has(t.getHours()) &&
      spec.minute.has(t.getMinutes()) &&
      matchesDay(spec, t)
    ) {
      return t;
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

// ───────────────────────────── trigger runner ───────────────────────────────

export interface TriggerResult {
  exitCode: number | null; // null when killed (timeout / signal)
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const CAP = 4096; // ~4 KB cap on captured stdout/stderr per the contract

function cap(s: string): string {
  return s.length > CAP ? `${s.slice(0, CAP)}\n…[truncated]` : s;
}

// Run a trigger script: `/bin/bash <path>` (honors a shebang via bash), cwd =
// project root, inheriting the daemon's env, with a short timeout. A timeout is
// a trigger error. Captures stdout/stderr (capped). Never rejects.
export function runTrigger(
  scriptPath: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<TriggerResult> {
  return new Promise((resolveResult) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        stdout: cap(stdout),
        stderr: cap(stderr),
        durationMs: Date.now() - start,
      });
    };
    let child;
    try {
      // detached → its own process group, so on timeout we can SIGKILL the whole
      // group (bash + any children like `sleep`) instead of orphaning grandchildren
      // that hold the stdout pipe open and delay 'close'.
      child = spawn("/bin/bash", [scriptPath], { cwd, detached: true });
    } catch (err) {
      stderr += String(err);
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // Don't wait for 'close' (grandchildren may linger) — settle now.
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (stdout.length < CAP * 2) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < CAP * 2) stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      stderr += String(e);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

// ───────────────────────────── local state ──────────────────────────────────

export interface LoopLocalEntry {
  enabled: boolean;
  trusted: Record<string, string>; // scriptPath (rel to .hitch/) → sha256
}

// Read the project's loop local state (enabled + trusted hashes) from the
// desktop app's preferences.json (sibling of config.json). Local-only,
// never synced. Read fresh each tick so a UI toggle takes effect without a
// daemon restart. Absent/garbled → empty (everything disabled).
export function readLoopLocalState(
  prefsRaw: string | null,
  projectId: string,
): Record<string, LoopLocalEntry> {
  if (!prefsRaw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(prefsRaw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const loops = (parsed as Record<string, unknown>).loops;
  if (typeof loops !== "object" || loops === null) return {};
  const project = (loops as Record<string, unknown>)[projectId];
  if (typeof project !== "object" || project === null) return {};
  const out: Record<string, LoopLocalEntry> = {};
  for (const [loopPath, value] of Object.entries(
    project as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const trusted: Record<string, string> = {};
    if (typeof v.trusted === "object" && v.trusted !== null) {
      for (const [k, h] of Object.entries(v.trusted as Record<string, unknown>)) {
        if (typeof h === "string") trusted[k] = h;
      }
    }
    out[loopPath] = { enabled: v.enabled === true, trusted };
  }
  return out;
}
