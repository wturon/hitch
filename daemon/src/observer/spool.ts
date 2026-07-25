// The hook inbox — a spool DIRECTORY, not a database.
//
// docs/chat-tracking-redesign.md §6. Hooks are independent short-lived
// processes that fire when the daemon is dead, the machine is offline, or the
// server is down, and they must never block the harness. So they need a durable
// local landing zone — but the inbox only needs APPEND and DRAIN, and SQLite is
// a heavy way to buy them.
//
// Contract with the hook template (desktop/src/main/main.ts
// `globalChatLifecycleHook`), which is the only writer:
//   - one JSON file per event in `<appSupportDir>/events/`
//   - filename `<epochMs>-<6 hex>.json`, so a lexical sort is ~chronological
//   - written to `<name>.tmp` then renameSync'd, so a reader can never see a
//     half-written file
//
// The daemon is the only reader: it drains (read → parse → DELETE) on every
// tick. A malformed file is skipped AND deleted — never retried forever. The
// write itself is the wake signal (fs.watch on the dir), so there is no bump
// file.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";

import { appSupportDirFromEnv } from "../v2/config.js";

// The normalized lifecycle event the hook writes. Deliberately the SAME shape
// the hook has always built (the hook's `normalize()` is unchanged) — only the
// medium moved. Everything is optional-with-a-guard here because the file on
// disk is untrusted input.
export interface SpooledEvent {
  eventId: string;
  source: string;
  producer: string;
  /** Hook vocabulary: "claude-code" | "codex". */
  harness: string;
  providerEvent: string;
  lifecycle: string;
  status: string | null;
  chatId: string;
  launchId: string | null;
  turnId: string | null;
  cwd: string;
  host: string;
  /** epoch ms */
  observedAt: number;
  metadata: Record<string, unknown>;
}

export interface SpoolPaths {
  appSupportDir: string;
  eventsDir: string;
  cursorsPath: string;
}

export function resolveSpoolPaths(env: NodeJS.ProcessEnv = process.env): SpoolPaths {
  const appSupportDir = appSupportDirFromEnv(env);
  return {
    appSupportDir,
    eventsDir: join(appSupportDir, "events"),
    cursorsPath: join(appSupportDir, "cursors.json"),
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Parse one spooled file. Returns null for anything we can't use — the caller
// deletes it either way, so a poison file can never wedge the drain.
export function parseSpooledEvent(raw: string): SpooledEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const chatId = asString(v.chatId);
  const harness = asString(v.harness);
  const lifecycle = asString(v.lifecycle);
  if (!chatId || !harness || !lifecycle) return null;
  const observedAt = Number(v.observedAt);
  return {
    eventId: asString(v.eventId) ?? `${chatId}:${lifecycle}:${observedAt}`,
    source: asString(v.source) ?? "hook",
    producer: asString(v.producer) ?? "unknown",
    harness,
    providerEvent: asString(v.providerEvent) ?? lifecycle,
    lifecycle,
    status: asString(v.status),
    chatId,
    launchId: asString(v.launchId),
    turnId: asString(v.turnId),
    cwd: asString(v.cwd) ?? "",
    host: asString(v.host) ?? "",
    observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
    metadata:
      typeof v.metadata === "object" && v.metadata !== null && !Array.isArray(v.metadata)
        ? (v.metadata as Record<string, unknown>)
        : {},
  };
}

export interface SpoolDrainResult {
  events: SpooledEvent[];
  /** Files that parsed to nothing usable. Deleted, never retried. */
  malformed: number;
  /** Files still on disk after this drain (the cap bit), for backlog reporting. */
  remaining: number;
}

const DEFAULT_DRAIN_LIMIT = 500;

export class EventSpool {
  readonly dir: string;
  private readonly onWake: (() => void) | null;
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: { dir: string; onWake?: () => void; debounceMs?: number }) {
    this.dir = options.dir;
    this.onWake = options.onWake ?? null;
    this.debounceMs = options.debounceMs ?? 250;
  }

  // Watch the spool dir: the hook's write IS the wake signal. Debounced, because
  // a single turn can fire several hooks back to back. Never throws — a machine
  // with no hooks installed simply has no dir yet, and we create it.
  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // Unwritable app-support dir: the drain will just find nothing.
    }
    if (!this.onWake) return;
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => this.wake());
    } catch {
      this.watcher = null; // the tick floor still drains
    }
  }

  private wake(): void {
    if (this.stopped || !this.onWake) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.onWake?.();
    }, this.debounceMs);
    this.debounce.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }

  // Read → parse → DELETE. Drained events live only in the next snapshot; they
  // are gone from local disk the moment we've read them, which is the whole
  // point of an inbox (§8: "An inbox is not append-only history").
  drain(limit = DEFAULT_DRAIN_LIMIT): SpoolDrainResult {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { events: [], malformed: 0, remaining: 0 };
    }
    // `.tmp` files are mid-write by definition — the hook renames into place.
    const ready = names.filter((n) => n.endsWith(".json")).sort();
    const batch = ready.slice(0, limit);
    const events: SpooledEvent[] = [];
    let malformed = 0;
    for (const name of batch) {
      const path = join(this.dir, name);
      let raw: string | null = null;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        raw = null;
      }
      const event = raw === null ? null : parseSpooledEvent(raw);
      if (event) events.push(event);
      else malformed += 1;
      try {
        unlinkSync(path);
      } catch {
        // Already gone (a second drain, or a manual wipe) — nothing to do.
      }
    }
    events.sort((a, b) => a.observedAt - b.observedAt);
    return { events, malformed, remaining: Math.max(0, ready.length - batch.length) };
  }
}
