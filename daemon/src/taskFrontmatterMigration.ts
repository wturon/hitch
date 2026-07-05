// Todos v1 (slice 6a): one-time task-frontmatter migration.
//
// The board's manual `status:` field is replaced by derived timestamps
// (Decision 7 / §4 of the Todos v1 PRD). This is a file rewrite, not a data
// migration: the daemon walks every `tasks/<slug>/task.md` under a binding and
// rewrites its frontmatter, then pushes each change up through Convex via the
// normal sync path. Convex follows, and every other machine converges.
//
// Design mirrors skills.ts: a pure core (`planTaskFrontmatterMigration` +
// project.json marker helpers) separated from the wiring (`runTaskFrontmatterMigration`,
// which injects `pushLocal`). The pure core reuses the daemon's real
// `frontmatterValue`/`setFrontmatterKeys` so rewrites preserve the body and all
// untouched frontmatter keys byte-for-byte.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { frontmatterValue, setFrontmatterKeys } from "./frontmatter.js";

// The synced schema version. When project.json already carries a marker >= this,
// the walk is skipped entirely (the migration already ran, possibly on another
// machine — the marker syncs, so it runs once per project, not per machine).
export const TODOS_SCHEMA_VERSION = 1;

const PROJECT_CONFIG_FILENAME = "project.json";
const TASK_FILENAME = "task.md";
const TASKS_DIR = "tasks";
const SCHEMA_VERSION_KEY = "todosSchemaVersion";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Normalize a `status:` value the same way the daemon's `taskStatus` does, so
// e.g. `Done` / `In Progress` map to `done` / `in-progress`.
function normalizeStatus(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

// Pure per-file rewrite plan. Returns the migrated content, or null when there
// is nothing to do (no `status:` line, or the rewrite is a no-op). Idempotent by
// construction: once `status:` is gone a second pass returns null immediately.
//
//   status: done     → set `completed-at` = mtimeISO, drop `status:`
//   status: archived → set `archived-at`  = mtimeISO, drop `status:`
//   any other status → drop `status:` only (task falls back to Backlog; the
//                       `waiting`/`review` flavor is knowingly lost — Decision 9)
//
// `mtimeISO` must be the file's PRE-write mtime (the rewrite bumps mtime), so the
// caller stats before writing.
export function planTaskFrontmatterMigration(
  content: string,
  mtimeISO: string,
): string | null {
  const raw = frontmatterValue(content, "status");
  if (raw === undefined) return null; // no status line → nothing to migrate

  const status = normalizeStatus(raw);
  let updates: Record<string, string | undefined>;
  if (status === "done") {
    updates = { status: undefined, "completed-at": mtimeISO };
  } else if (status === "archived") {
    updates = { status: undefined, "archived-at": mtimeISO };
  } else {
    updates = { status: undefined };
  }

  const next = setFrontmatterKeys(content, updates);
  return next === content ? null : next;
}

// Read the synced schema marker out of a project.json string. Absent/garbled →
// 0 (treat as unmigrated). Only reads `todosSchemaVersion`; everything else
// (notably `projectId`) is ignored here.
export function readTodosSchemaVersion(projectJson: string): number {
  try {
    const parsed: unknown = JSON.parse(projectJson);
    if (isRecord(parsed) && typeof parsed[SCHEMA_VERSION_KEY] === "number") {
      return parsed[SCHEMA_VERSION_KEY] as number;
    }
  } catch {
    // unparseable → treat as unmigrated
  }
  return 0;
}

// Return project.json with `todosSchemaVersion` set to `version`, preserving all
// existing fields (a garbled/missing file becomes a fresh object with only the
// marker). Adding this sibling field is inert to `readDiskProjectId`, which only
// reads `projectId`.
export function withTodosSchemaVersion(
  projectJson: string,
  version: number,
): string {
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(projectJson);
    if (isRecord(parsed)) obj = parsed;
  } catch {
    // start fresh — nothing worth preserving
  }
  obj[SCHEMA_VERSION_KEY] = version;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export interface TaskMigrationLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface TaskMigrationDeps {
  // The binding's `.hitch` directory (holds `project.json` and `tasks/`).
  hitchPath: string;
  // Sync a rewritten file up to Convex. Injected (not imported) so the smoke can
  // run with no network and no Convex client — the daemon passes its real
  // `pushLocal`.
  pushLocal: (absPath: string) => Promise<void>;
  logger: TaskMigrationLogger;
}

export interface TaskMigrationResult {
  // True when the marker was already >= TODOS_SCHEMA_VERSION and the walk was
  // skipped without touching anything.
  skipped: boolean;
  // Number of task.md files actually rewritten this pass.
  migrated: number;
}

// Walk `tasks/<slug>/task.md` under the binding and migrate each. Marker-gated:
// if project.json already records version >= current, skips the walk entirely.
// The marker is written (and pushed) only after a fully successful walk, so an
// interrupted run leaves it unwritten and the idempotent walk resumes next boot.
export async function runTaskFrontmatterMigration(
  deps: TaskMigrationDeps,
): Promise<TaskMigrationResult> {
  const { hitchPath, pushLocal, logger } = deps;
  const projectJsonPath = join(hitchPath, PROJECT_CONFIG_FILENAME);

  const currentVersion = readTodosSchemaVersion(
    await readFileOr(projectJsonPath, "{}"),
  );
  if (currentVersion >= TODOS_SCHEMA_VERSION) {
    return { skipped: true, migrated: 0 };
  }

  const migrated = await migrateAllTasks(hitchPath, pushLocal, logger);

  // Mark the project migrated only after the walk fully succeeded. Re-read here
  // (rather than reuse the earlier read) so we merge onto the freshest bytes.
  const nextJson = withTodosSchemaVersion(
    await readFileOr(projectJsonPath, "{}"),
    TODOS_SCHEMA_VERSION,
  );
  await writeFile(projectJsonPath, nextJson, "utf8");
  await pushLocal(projectJsonPath);

  if (migrated > 0) {
    logger.info(
      `task frontmatter migration rewrote ${migrated} task(s); marked todosSchemaVersion ${TODOS_SCHEMA_VERSION}`,
    );
  }
  return { skipped: false, migrated };
}

// Walk pattern mirrors reconcileChatStatusInDir: readdir(withFileTypes), one
// task dir at a time, read → plan → (write + pushLocal). A read failure on any
// single file is skipped, never thrown.
async function migrateAllTasks(
  hitchPath: string,
  pushLocal: (absPath: string) => Promise<void>,
  logger: TaskMigrationLogger,
): Promise<number> {
  const baseDir = join(hitchPath, TASKS_DIR);
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return 0; // no tasks/ dir yet
  }

  let migrated = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absPath = join(baseDir, entry.name, TASK_FILENAME);

    let content: string;
    let mtimeISO: string;
    try {
      // Stat BEFORE the write so `completed-at`/`archived-at` reflect the file's
      // pre-migration mtime, not the mtime the rewrite bumps it to.
      const stats = await stat(absPath);
      mtimeISO = new Date(stats.mtimeMs).toISOString();
      content = await readFile(absPath, "utf8");
    } catch {
      continue; // no task.md here (or unreadable) → skip
    }

    const next = planTaskFrontmatterMigration(content, mtimeISO);
    if (next === null) continue;

    await writeFile(absPath, next, "utf8");
    await pushLocal(absPath);
    migrated++;
    logger.info(`migrated ${TASKS_DIR}/${entry.name}/${TASK_FILENAME}`);
  }
  return migrated;
}

async function readFileOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}
