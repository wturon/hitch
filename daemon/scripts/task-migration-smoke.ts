import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FRONTMATTER_RE } from "../src/frontmatter";
import {
  TODOS_SCHEMA_VERSION,
  runTaskFrontmatterMigration,
  type TaskMigrationDeps,
} from "../src/taskFrontmatterMigration";

// This smoke runs entirely against a fabricated `.hitch` fixture in a temp dir —
// NEVER real .hitch data or ~/.claude. `pushLocal` is stubbed (no network, no
// Convex client) and only records which paths would have synced, so the real
// walk/rewrite logic is exercised end to end.

const silentLogger = { info: () => {}, error: () => {} };

// Split a doc into [frontmatterLines, body] so we can assert byte-fidelity of
// untouched keys and the body independently.
function parts(content: string): { fm: string[]; body: string } {
  const match = content.match(FRONTMATTER_RE);
  assert.ok(match, "fixture must have frontmatter");
  return { fm: match[1].split(/\r?\n/), body: match[2] };
}

function fmLine(content: string, key: string): string | undefined {
  return parts(content).fm.find((l) => l.split(":")[0]?.trim() === key);
}

function hasKey(content: string, key: string): boolean {
  return fmLine(content, key) !== undefined;
}

const tmp = mkdtempSync(join(tmpdir(), "hitch-task-migration-"));

try {
  const hitchPath = join(tmp, ".hitch");
  const tasksDir = join(hitchPath, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // --- Fixtures -----------------------------------------------------------
  function writeTask(slug: string, content: string): string {
    const dir = join(tasksDir, slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "task.md");
    writeFileSync(path, content, "utf8");
    return path;
  }

  const doneContent = [
    "---",
    "title: Ship the thing",
    "status: done",
    "chat-id: chat_abc",
    "priority: high",
    "---",
    "",
    "The body of the done task.",
    "",
    "Second paragraph, preserved verbatim.",
    "",
  ].join("\n");

  const archivedContent = [
    "---",
    "title: Old idea",
    "status: archived",
    "created: 2026-01-01",
    "---",
    "Archived body text.",
    "",
  ].join("\n");

  const wipContent = [
    "---",
    "title: In flight",
    "status: in-progress",
    "chat-id: chat_wip",
    "---",
    "Working on it.",
    "",
  ].join("\n");

  const noStatusContent = [
    "---",
    "title: No status here",
    "chat-request: requested",
    "---",
    "Body with no status frontmatter.",
    "",
  ].join("\n");

  const alreadyDoneContent = [
    "---",
    "title: Already migrated",
    "completed-at: 2026-06-01T00:00:00.000Z",
    "---",
    "This one was migrated already.",
    "",
  ].join("\n");

  const donePath = writeTask("done-task", doneContent);
  const archivedPath = writeTask("archived-task", archivedContent);
  const wipPath = writeTask("wip-task", wipContent);
  const noStatusPath = writeTask("no-status-task", noStatusContent);
  const alreadyDonePath = writeTask("already-done-task", alreadyDoneContent);

  const projectJsonPath = join(hitchPath, "project.json");
  writeFileSync(
    projectJsonPath,
    JSON.stringify({ projectId: "proj_test_123", localPath: "/somewhere" }, null, 2),
    "utf8",
  );

  // Capture the exact pre-write mtimes the migration will stat, so we can assert
  // completed-at/archived-at equal them. Nothing writes between here and the
  // migration's own stat, so the mtimeMs (and its ISO) are identical.
  const doneMtimeISO = new Date(statSync(donePath).mtimeMs).toISOString();
  const archivedMtimeISO = new Date(statSync(archivedPath).mtimeMs).toISOString();

  // Stub pushLocal — record synced paths per pass, no network.
  let synced: string[] = [];
  const deps: TaskMigrationDeps = {
    hitchPath,
    pushLocal: async (absPath) => {
      synced.push(absPath);
    },
    logger: silentLogger,
  };

  // === PASS 1: the real migration ========================================
  synced = [];
  const pass1 = await runTaskFrontmatterMigration(deps);
  assert.equal(pass1.skipped, false, "pass 1 must not skip (no marker yet)");
  assert.equal(pass1.migrated, 3, "pass 1 rewrites done + archived + wip (3)");

  const done1 = readFileSync(donePath, "utf8");
  const archived1 = readFileSync(archivedPath, "utf8");
  const wip1 = readFileSync(wipPath, "utf8");
  const noStatus1 = readFileSync(noStatusPath, "utf8");
  const alreadyDone1 = readFileSync(alreadyDonePath, "utf8");

  // done: status dropped, completed-at == pre-write mtime ISO (acceptance 19).
  assert.equal(hasKey(done1, "status"), false, "done: status line removed");
  assert.equal(
    fmLine(done1, "completed-at"),
    `completed-at: ${doneMtimeISO}`,
    "done: completed-at == pre-write mtime ISO",
  );
  assert.equal(hasKey(done1, "archived-at"), false, "done: no archived-at");
  // Body + all other frontmatter keys byte-identical.
  assert.equal(parts(done1).body, parts(doneContent).body, "done: body byte-identical");
  for (const key of ["title", "chat-id", "priority"]) {
    assert.equal(
      fmLine(done1, key),
      fmLine(doneContent, key),
      `done: '${key}' frontmatter line byte-preserved`,
    );
  }

  // archived: status dropped, archived-at == mtime ISO.
  assert.equal(hasKey(archived1, "status"), false, "archived: status removed");
  assert.equal(
    fmLine(archived1, "archived-at"),
    `archived-at: ${archivedMtimeISO}`,
    "archived: archived-at == pre-write mtime ISO",
  );
  assert.equal(hasKey(archived1, "completed-at"), false, "archived: no completed-at");
  assert.equal(parts(archived1).body, parts(archivedContent).body, "archived: body byte-identical");
  assert.equal(fmLine(archived1, "created"), fmLine(archivedContent, "created"), "archived: 'created' preserved");

  // wip (arbitrary status): status line deleted only — no timestamps added.
  assert.equal(hasKey(wip1, "status"), false, "wip: status removed");
  assert.equal(hasKey(wip1, "completed-at"), false, "wip: no completed-at");
  assert.equal(hasKey(wip1, "archived-at"), false, "wip: no archived-at");
  assert.equal(parts(wip1).body, parts(wipContent).body, "wip: body byte-identical");
  assert.equal(fmLine(wip1, "chat-id"), fmLine(wipContent, "chat-id"), "wip: 'chat-id' preserved");

  // no-status & already-migrated: completely untouched.
  assert.equal(noStatus1, noStatusContent, "no-status task byte-identical (skipped)");
  assert.equal(alreadyDone1, alreadyDoneContent, "already-migrated task byte-identical (skipped)");

  // project.json: gains todosSchemaVersion, keeps projectId readable.
  const projJson1 = JSON.parse(readFileSync(projectJsonPath, "utf8"));
  assert.equal(projJson1.todosSchemaVersion, TODOS_SCHEMA_VERSION, "marker written == 1");
  assert.equal(projJson1.projectId, "proj_test_123", "projectId still readable");
  assert.equal(projJson1.localPath, "/somewhere", "other project.json fields preserved");

  // pushLocal: the 3 rewritten task files + project.json marker (not the skips).
  assert.deepEqual(
    [...synced].sort(),
    [donePath, archivedPath, wipPath, projectJsonPath].sort(),
    "pass 1 syncs exactly the 3 rewritten tasks + project.json",
  );

  // === PASS 2: marker present → skip, zero writes ========================
  synced = [];
  const pass2 = await runTaskFrontmatterMigration(deps);
  assert.equal(pass2.skipped, true, "pass 2 skips (marker >= 1)");
  assert.equal(pass2.migrated, 0, "pass 2 migrates nothing");
  assert.equal(synced.length, 0, "pass 2 performs zero pushLocal writes");
  // Every file byte-identical to end of pass 1.
  assert.equal(readFileSync(donePath, "utf8"), done1, "pass 2: done unchanged");
  assert.equal(readFileSync(archivedPath, "utf8"), archived1, "pass 2: archived unchanged");
  assert.equal(readFileSync(wipPath, "utf8"), wip1, "pass 2: wip unchanged");

  // === PASS 3: marker forcibly removed → idempotent walk, no content change ==
  // Prove idempotency does NOT depend on the marker: with the marker gone the
  // walk runs, but no `status:` lines remain so every task plan is a no-op.
  writeFileSync(
    projectJsonPath,
    JSON.stringify({ projectId: "proj_test_123", localPath: "/somewhere" }, null, 2),
    "utf8",
  );
  synced = [];
  const pass3 = await runTaskFrontmatterMigration(deps);
  assert.equal(pass3.skipped, false, "pass 3 does not skip (marker removed)");
  assert.equal(pass3.migrated, 0, "pass 3 rewrites zero tasks (no status lines left)");
  // No task.md content changed — only the marker is re-established.
  assert.equal(readFileSync(donePath, "utf8"), done1, "pass 3: done unchanged");
  assert.equal(readFileSync(archivedPath, "utf8"), archived1, "pass 3: archived unchanged");
  assert.equal(readFileSync(wipPath, "utf8"), wip1, "pass 3: wip unchanged");
  assert.equal(readFileSync(noStatusPath, "utf8"), noStatusContent, "pass 3: no-status unchanged");
  assert.equal(readFileSync(alreadyDonePath, "utf8"), alreadyDoneContent, "pass 3: already-done unchanged");
  // Only project.json (the re-written marker) is pushed; zero task-file writes.
  assert.deepEqual(synced, [projectJsonPath], "pass 3 syncs only the re-written marker");
  const projJson3 = JSON.parse(readFileSync(projectJsonPath, "utf8"));
  assert.equal(projJson3.todosSchemaVersion, TODOS_SCHEMA_VERSION, "pass 3 re-writes marker");
  assert.equal(projJson3.projectId, "proj_test_123", "pass 3: projectId still readable");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("task migration smoke passed");
