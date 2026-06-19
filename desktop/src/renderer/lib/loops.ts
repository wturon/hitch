// A loop is a folder under `loops/`, its definition in index.md (frontmatter =
// knobs, body = the agent prompt) plus an optional trigger.sh. Mirrors the
// "task = folder" / "note = folder" convention on top of the file primitive —
// the daemon still syncs individual files. Run history lives in Convex
// (loopRuns), never in the file. See the Loops PRD.

import {
  parseFrontmatter,
  splitFrontmatter,
} from "@/lib/frontmatter";
import type { Harness } from "@/lib/chat";

const LOOP_RE = /^loops\/([^/]+)\/index\.md$/;
const TRIGGER_RE = /^loops\/([^/]+)\/trigger\.sh$/;

// The slug for a loop's canonical file, or null if `path` isn't one.
export function loopSlug(path: string): string | null {
  const match = path.match(LOOP_RE);
  return match ? match[1] : null;
}

// The slug of a loop's trigger.sh, or null if `path` isn't one.
export function triggerSlug(path: string): string | null {
  const match = path.match(TRIGGER_RE);
  return match ? match[1] : null;
}

// The loop dir relative to .hitch/ — the run-record identity ("loops/<slug>").
export function loopDirPath(slug: string): string {
  return `loops/${slug}`;
}

// The on-disk path of a loop's canonical definition, from its slug.
export function loopBodyPath(slug: string): string {
  return `loops/${slug}/index.md`;
}

// The on-disk path of a loop's optional trigger script, from its slug.
export function loopTriggerPath(slug: string): string {
  return `loops/${slug}/trigger.sh`;
}

// The in-memory model the Loops UI renders, parsed from a loop's index.md.
export interface LoopDoc {
  slug: string;
  loopPath: string; // "loops/<slug>" — matches loopRuns.loopPath
  path: string; // "loops/<slug>/index.md"
  title: string;
  schedule: string; // 5-field cron
  harness: Harness;
  model?: string;
  reasoning?: string;
  timeoutMinutes?: number;
  concurrency: string;
  prompt: string; // the body
  content: string; // raw file (frontmatter + body), written back verbatim
  hasTrigger: boolean;
  updatedAt: number;
}

interface FileDoc {
  path: string;
  content: string;
  deleted: boolean;
  updatedAt: number;
}

function normHarness(value: string | undefined): Harness {
  return value === "codex" ? "codex" : "claude-code";
}

// Build the loop list from the project's files: keep only canonical index.md
// definitions, parse frontmatter, note whether a sibling trigger.sh exists, drop
// tombstones.
export function loopDocs(files: FileDoc[]): LoopDoc[] {
  const triggers = new Set(
    files
      .filter((f) => !f.deleted)
      .map((f) => triggerSlug(f.path))
      .filter((s): s is string => s !== null),
  );
  return files.reduce<LoopDoc[]>((acc, f) => {
    if (f.deleted) return acc;
    const slug = loopSlug(f.path);
    if (slug === null) return acc;
    const { frontmatter } = parseFrontmatter(f.content);
    const { body } = splitFrontmatter(f.content);
    const timeout = Number(frontmatter.timeoutMinutes);
    acc.push({
      slug,
      loopPath: loopDirPath(slug),
      path: f.path,
      title: frontmatter.title || slug,
      schedule: frontmatter.schedule || "*/30 * * * *",
      harness: normHarness(frontmatter.harness),
      model: frontmatter.model || undefined,
      reasoning: frontmatter.reasoning || undefined,
      timeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      concurrency: frontmatter.concurrency || "skip",
      prompt: body,
      content: f.content,
      hasTrigger: triggers.has(slug),
      updatedAt: f.updatedAt,
    });
    return acc;
  }, []);
}

// ───────────────────────── cron (standard 5-field, local tz) ─────────────────

// Parse one cron field ("*", "*/n", "a", "a-b", "a,b", combos) into the set of
// allowed values within [min, max]. Returns null on a malformed field.
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
  // cron allows 0 or 7 for Sunday; normalize 7→0.
  const dowRaw = parseField(fields[4].replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow: dowRaw,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

// Next fire time at or after `after` (exclusive of the current minute's already
// past seconds). Local timezone, 1-minute granularity, no catch-up. Returns null
// if the expression is invalid or nothing fires within a year.
export function cronNextRun(expr: string, after: Date): Date | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  // Start at the next whole minute.
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

// cron's day match: when both DOM and DOW are restricted, a match on EITHER
// fires (the historical Vixie-cron rule); when only one is restricted, that one
// must match; when neither, any day.
function matchesDay(spec: CronSpec, t: Date): boolean {
  const domOk = spec.dom.has(t.getDate());
  const dowOk = spec.dow.has(t.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(h: number, m: number): string {
  const period = h < 12 ? "a" : "p";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${period}` : `${hour12}:${String(m).padStart(2, "0")}${period}`;
}

// A short human label for a schedule, for the index meta line. Falls back to the
// raw expression for anything it doesn't special-case.
export function humanizeCron(expr: string): string {
  const spec = parseCron(expr);
  if (!spec) return expr;
  const fields = expr.trim().split(/\s+/);
  const [minF, hourF, , , dowF] = fields;
  const everyMin = minF.startsWith("*/") && hourF === "*";
  if (everyMin) {
    const n = Number(minF.slice(2));
    return n === 1 ? "every minute" : `every ${n} min`;
  }
  if (minF === "*" && hourF === "*") return "every minute";
  // Single fixed minute + hour cases.
  if (spec.minute.size === 1 && spec.hour.size === 1) {
    const m = [...spec.minute][0];
    const h = [...spec.hour][0];
    const time = fmtTime(h, m);
    if (!spec.domRestricted && !spec.dowRestricted) return `daily ${time}`;
    if (spec.dowRestricted) {
      const days = [...spec.dow].sort((a, b) => a - b);
      const isWeekdays =
        days.length === 5 && days.every((d) => d >= 1 && d <= 5);
      if (isWeekdays) return `weekdays ${time}`;
      if (days.length === 1) return `${DAY_NAMES[days[0]]} ${time}`;
      return `${days.map((d) => DAY_NAMES[d]).join("/")} ${time}`;
    }
    return `monthly ${time}`;
  }
  // Hourly at a fixed minute.
  if (spec.minute.size === 1 && hourF === "*") return "hourly";
  if (dowF !== "*" && spec.dow.size === 1) return `weekly ${DAY_NAMES[[...spec.dow][0]]}`;
  return expr;
}

// The progress fraction (0..1) through the current cycle, for the ring arc:
// elapsed since the previous fire over the gap to the next fire. Falls back to 0
// when either bound is unknown.
export function cycleProgress(
  expr: string,
  next: Date | null,
  now: Date,
): number {
  if (!next) return 0;
  const prev = cronNextRun(expr, new Date(now.getTime() - cycleGuess(expr)));
  // prev is the fire at/after (now - gap); we actually want the most recent past
  // fire, so step back from `next` by one cycle using the inferred gap.
  const gap = next.getTime() - (prev ? prev.getTime() : next.getTime());
  const start = gap > 0 ? next.getTime() - gap : next.getTime();
  if (next.getTime() <= start) return 0;
  const frac = (now.getTime() - start) / (next.getTime() - start);
  return Math.max(0, Math.min(1, frac));
}

// A rough cycle length used only to seed the progress lookback. Not exact; the
// ring arc is decorative.
function cycleGuess(expr: string): number {
  const next1 = cronNextRun(expr, new Date(0));
  const next2 = next1 ? cronNextRun(expr, next1) : null;
  if (next1 && next2) return Math.max(60_000, next2.getTime() - next1.getTime());
  return 30 * 60_000;
}

// The center label inside the ring: a live mm:ss countdown for sub-hour gaps, a
// coarse "38m" for longer-but-today, a clock time like "8:30a" for daily/weekly,
// or a weekday like "Mon" when it's days out. Returns "" when paused/unknown.
export function ringCountdown(next: Date | null, now: Date): string {
  if (!next) return "";
  const ms = next.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hours = Math.floor(min / 60);
  if (min < 60) {
    // mm:ss for the final hour.
    return `${min}:${String(sec % 60).padStart(2, "0")}`;
  }
  const sameDay = next.toDateString() === now.toDateString();
  if (sameDay) return `${Math.round(min / 60) >= 1 ? `${hours}h` : `${min}m`}`;
  const days = Math.floor(hours / 24);
  if (days < 1) {
    return fmtTime(next.getHours(), next.getMinutes());
  }
  if (days < 7) return DAY_NAMES[next.getDay()];
  return next.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
