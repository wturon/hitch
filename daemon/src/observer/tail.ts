import { closeSync, openSync, readSync, statSync } from "node:fs";

// Incremental, restart-safe JSONL tailer. Both harnesses append to their logs
// in real time, so we read only the bytes appended since we last looked
// (`[offset, size)`), advancing the offset only past *complete* lines. The
// trailing partial line is left unconsumed and re-read next time — we never
// hand a half-written JSON line to the parser.
//
// File identity ((dev, ino)) plus size guard against the two ways a tail breaks:
//   - truncation / log rotation (size shrank, or inode changed) → reset to a
//     bounded tail window rather than reading a stale offset past EOF.
//   - daemon restart → the persisted cursor (stored in SQLite) resumes cleanly.

// On a cold start (no prior cursor) or after a reset we don't want to read a
// multi-MB transcript; seek to the last window and accept that the first
// (partial) line may be dropped — derivation only needs the last relevant line.
const DEFAULT_INITIAL_WINDOW_BYTES = 256 * 1024;

export interface TailCursor {
  dev: number;
  ino: number;
  offset: number;
  size: number;
  mtimeMs: number;
}

export interface TailResult {
  cursor: TailCursor;
  // Complete lines consumed since `prior` (trailing partial line excluded).
  lines: string[];
  // The file rotated/truncated since `prior`, so the offset was reset.
  reset: boolean;
  // The file changed at all since `prior` (size or mtime moved). Cheap freshness
  // signal even when no complete new line landed yet.
  changed: boolean;
}

function emptyCursor(): TailCursor {
  return { dev: 0, ino: 0, offset: 0, size: 0, mtimeMs: 0 };
}

// Read the lines appended to `path` since `prior`. Returns a fresh cursor to
// persist. On any stat/IO error returns the prior cursor unchanged with no
// lines (the caller treats a vanished file as a separate signal).
export function tailFile(
  path: string,
  prior: TailCursor | null,
  options: { initialWindowBytes?: number } = {},
): TailResult | null {
  let dev: number;
  let ino: number;
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    dev = st.dev;
    ino = st.ino;
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }

  const window = options.initialWindowBytes ?? DEFAULT_INITIAL_WINDOW_BYTES;
  const rotated = !!prior && (prior.dev !== dev || prior.ino !== ino);
  const truncated = !!prior && size < prior.offset;
  const cold = !prior;
  const reset = cold || rotated || truncated;

  let start: number;
  if (reset) {
    start = Math.max(0, size - window);
  } else {
    start = prior!.offset;
  }

  const changed =
    reset || !prior || size !== prior.size || mtimeMs !== prior.mtimeMs;

  if (size <= start) {
    // Nothing new to read (or file shrank to before our window start).
    return {
      cursor: { dev, ino, offset: Math.min(start, size), size, mtimeMs },
      lines: [],
      reset,
      changed,
    };
  }

  const length = size - start;
  const buf = Buffer.allocUnsafe(length);
  let read: number;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    read = readSync(fd, buf, 0, length, start);
  } catch {
    return {
      cursor: prior ?? emptyCursor(),
      lines: [],
      reset: false,
      changed: false,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }

  const region = buf.subarray(0, read);
  const lastNewline = region.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // No complete line yet — hold the offset so we re-read this partial next time.
    return {
      cursor: { dev, ino, offset: start, size, mtimeMs },
      lines: [],
      reset,
      changed,
    };
  }

  const completeText = region.toString("utf8", 0, lastNewline + 1);
  const lines = completeText.split("\n").filter((line) => line.length > 0);
  const newOffset = start + lastNewline + 1;

  return {
    cursor: { dev, ino, offset: newOffset, size, mtimeMs },
    lines,
    reset,
    changed,
  };
}

// Read just the last `windowBytes` of a file as text — for one-shot derivation
// where we don't keep a cursor (e.g. the reconcile floor seeding a chat it has
// no prior offset for). The leading partial line is the caller's to discard.
export function readTailWindow(
  path: string,
  windowBytes = DEFAULT_INITIAL_WINDOW_BYTES,
): string | null {
  const result = tailFile(path, null, { initialWindowBytes: windowBytes });
  if (!result) return null;
  return result.lines.join("\n");
}

export interface LatestTail {
  // The complete lines in the current tail window — re-read every call, so the
  // *current* last-relevant line is always present regardless of whether the
  // file grew since last time.
  lines: string[];
  // The file changed (size/mtime/identity) since `prior` — the leading-edge
  // "working" trigger.
  changed: boolean;
  cursor: TailCursor;
}

// Level-triggered tail: read the last `windowBytes` of the file *every call* and
// return its complete lines, so derivation reflects the current latest-turn
// state rather than only newly-appended bytes. This is the fix for the
// edge-triggered trap — an open tool with no new output stays visible in the
// window (and thus `working`) until the log actually gains a terminal marker.
// The cursor is still returned so callers can detect change cheaply next time.
const LATEST_TAIL_WINDOW_BYTES = 128 * 1024;
export function readLatestTail(
  path: string,
  prior: TailCursor | null,
  options: { windowBytes?: number } = {},
): LatestTail | null {
  let dev: number;
  let ino: number;
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    dev = st.dev;
    ino = st.ino;
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }

  const changed =
    !prior ||
    prior.dev !== dev ||
    prior.ino !== ino ||
    prior.size !== size ||
    prior.mtimeMs !== mtimeMs;
  const cursor: TailCursor = { dev, ino, offset: size, size, mtimeMs };

  if (size === 0) return { lines: [], changed, cursor };

  const window = options.windowBytes ?? LATEST_TAIL_WINDOW_BYTES;
  const start = Math.max(0, size - window);
  const length = size - start;
  const buf = Buffer.allocUnsafe(length);
  let read: number;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    read = readSync(fd, buf, 0, length, start);
  } catch {
    return { lines: [], changed, cursor };
  } finally {
    if (fd !== null) closeSync(fd);
  }

  const region = buf.subarray(0, read);
  // When we began mid-file, the first line is a partial — drop it.
  let from = 0;
  if (start > 0) {
    const firstNewline = region.indexOf(0x0a);
    from = firstNewline >= 0 ? firstNewline + 1 : read;
  }
  // Drop the trailing partial line (everything after the last newline).
  const lastNewline = region.lastIndexOf(0x0a);
  if (lastNewline < from) return { lines: [], changed, cursor };
  const lines = region
    .toString("utf8", from, lastNewline + 1)
    .split("\n")
    .filter((line) => line.length > 0);
  return { lines, changed, cursor };
}
