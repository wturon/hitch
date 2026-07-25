// cursors.json — the daemon's only persistent local state.
//
// docs/chat-tracking-redesign.md §6. Replaces the `observed_files` SQLite table:
// per transcript we remember offset, file identity (dev/ino), size and mtime, so
// a restart resumes a tail cleanly and a "did this file move?" check is one
// stat.
//
// DISPOSABLE BY CONTRACT: delete this file at any moment and you lose in-flight
// precision at worst — every chat is re-derived from the machine on the next
// tick. `scripts/chat-spool-disposability-smoke.ts` asserts exactly that.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FileCursor {
  dev: number;
  ino: number;
  offset: number;
  size: number;
  mtimeMs: number;
  /** epoch ms of the last tick that touched this cursor — used to prune. */
  seenAt: number;
}

function isCursor(value: unknown): value is FileCursor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.dev === "number" &&
    typeof v.ino === "number" &&
    typeof v.offset === "number" &&
    typeof v.size === "number" &&
    typeof v.mtimeMs === "number"
  );
}

export class CursorStore {
  readonly path: string;
  private cursors = new Map<string, FileCursor>();
  private dirty = false;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  // Unreadable / malformed / absent → start empty. Never throws: a corrupt
  // cursor file must cost precision, not a daemon.
  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const entries = (parsed as Record<string, unknown>).cursors;
    if (typeof entries !== "object" || entries === null) return;
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (isCursor(value)) this.cursors.set(key, { ...value, seenAt: Number(value.seenAt) || 0 });
    }
  }

  get(key: string): FileCursor | null {
    return this.cursors.get(key) ?? null;
  }

  set(key: string, cursor: FileCursor): void {
    const prior = this.cursors.get(key);
    this.cursors.set(key, cursor);
    if (
      !prior ||
      prior.dev !== cursor.dev ||
      prior.ino !== cursor.ino ||
      prior.offset !== cursor.offset ||
      prior.size !== cursor.size ||
      prior.mtimeMs !== cursor.mtimeMs
    ) {
      this.dirty = true;
    }
  }

  // Forget cursors for chats that have aged out of the working set, so the file
  // stays proportional to what we're actually watching.
  prune(olderThanMs: number, now: number): void {
    for (const [key, cursor] of this.cursors) {
      if (now - cursor.seenAt > olderThanMs) {
        this.cursors.delete(key);
        this.dirty = true;
      }
    }
  }

  get size(): number {
    return this.cursors.size;
  }

  // Atomic (tmp + rename) so a crash mid-write can't leave a half file, and a
  // no-op when nothing moved. Swallows errors — cursors are an optimization.
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify(
      { version: 1, cursors: Object.fromEntries(this.cursors) },
      null,
      2,
    );
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, `${body}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
    }
  }
}
