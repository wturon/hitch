import assert from "node:assert/strict";

import {
  countTaskStatuses,
  deleteStatusMigrationPlan,
  normalizeStatuses,
  renameStatusMigrationPlan,
  taskContentWithStatus,
  taskStatusId,
} from "../../convex/projects";

const suffixed = normalizeStatuses([
  { id: "todo", name: "To Do" },
  { id: "tmp-1", name: "In Review" },
  { id: "tmp-2", name: "In   Review!" },
], [{ id: "todo", name: "To Do" }]);

assert.deepEqual(
  suffixed.map((status) => status.id),
  ["todo", "in-review", "in-review-2"],
);

assert.throws(
  () => normalizeStatuses([{ id: "tmp-archived", name: "Archived" }]),
  /reserved status id/,
);

const counts = countTaskStatuses(
  [
    {
      path: "tasks/one/task.md",
      deleted: false,
      content: "---\nstatus: todo\n---\n",
    },
    {
      path: "tasks/two/task.md",
      deleted: false,
      content: "---\nstatus: review\n---\n",
    },
    {
      path: "tasks/three/task.md",
      deleted: false,
      content: "---\nstatus: blocked\n---\n",
    },
    {
      path: "tasks/four/task.md",
      deleted: false,
      content: "---\ntitle: Missing status\n---\n",
    },
    {
      path: "tasks/five/task.md",
      deleted: true,
      content: "---\nstatus: todo\n---\n",
    },
    {
      path: "notes/one.md",
      deleted: false,
      content: "---\nstatus: todo\n---\n",
    },
  ],
  [
    { id: "todo", name: "To Do" },
    { id: "review", name: "Review" },
  ],
);

assert.deepEqual(counts, [
  { statusId: "todo", count: 2, configured: true },
  { statusId: "review", count: 1, configured: true },
  { statusId: "blocked", count: 1, configured: false },
]);

const renamedTask = taskContentWithStatus(
  "---\ntitle: Rename me\nstatus: in-review\nchat-status: waiting\n---\nBody\n",
  "review-ready",
);
assert.equal(
  renamedTask,
  "---\ntitle: Rename me\nstatus: review-ready\nchat-status: waiting\n---\nBody\n",
);
assert.equal(taskStatusId(renamedTask ?? ""), "review-ready");

const windowsNewlineTask = taskContentWithStatus(
  "---\r\ntitle: Delete me\r\nstatus: blocked\r\n---\r\nBody\r\n",
  "archived",
);
assert.equal(
  windowsNewlineTask,
  "---\r\ntitle: Delete me\r\nstatus: archived\r\n---\r\nBody\r\n",
);
assert.equal(taskStatusId(windowsNewlineTask ?? ""), "archived");

const migrationStatuses = [
  { id: "todo", name: "To Do" },
  { id: "in-review", name: "In Review" },
  { id: "done", name: "Done" },
  { id: "review-ready", name: "Review Ready" },
];
const migrationFiles = [
  {
    path: "tasks/one/task.md",
    deleted: false,
    content: "---\nstatus: in-review\n---\nOne\n",
  },
  {
    path: "tasks/two/task.md",
    deleted: false,
    content: "---\ntitle: Two\nstatus: in-review\n---\nTwo\n",
  },
  {
    path: "tasks/three/task.md",
    deleted: false,
    content: "---\nstatus: todo\n---\nThree\n",
  },
  {
    path: "tasks/deleted/task.md",
    deleted: true,
    content: "---\nstatus: in-review\n---\nDeleted\n",
  },
  {
    path: "notes/not-a-task.md",
    deleted: false,
    content: "---\nstatus: in-review\n---\nNote\n",
  },
];

const renamePlan = renameStatusMigrationPlan(
  migrationStatuses,
  migrationFiles,
  { statusId: "in-review", name: "Review Ready" },
);
assert.deepEqual(
  renamePlan.statuses.map((status) => status.id),
  ["todo", "review-ready-2", "done", "review-ready"],
);
assert.deepEqual(
  renamePlan.repoints.map((repoint) => ({
    path: repoint.file.path,
    nextStatusId: repoint.nextStatusId,
    statusId: taskStatusId(repoint.nextContent),
  })),
  [
    {
      path: "tasks/one/task.md",
      nextStatusId: "review-ready-2",
      statusId: "review-ready-2",
    },
    {
      path: "tasks/two/task.md",
      nextStatusId: "review-ready-2",
      statusId: "review-ready-2",
    },
  ],
);

assert.throws(
  () =>
    deleteStatusMigrationPlan(migrationStatuses, migrationFiles, {
      statusId: "in-review",
    }),
  /Destination status is required/,
);
assert.throws(
  () =>
    deleteStatusMigrationPlan(migrationStatuses, migrationFiles, {
      statusId: "in-review",
      destinationStatusId: "in-review",
    }),
  /Destination status must be different/,
);
assert.throws(
  () =>
    deleteStatusMigrationPlan(migrationStatuses, migrationFiles, {
      statusId: "in-review",
      destinationStatusId: "blocked",
    }),
  /Destination status does not exist/,
);

const archivePlan = deleteStatusMigrationPlan(
  migrationStatuses,
  migrationFiles,
  { statusId: "in-review", destinationStatusId: "archived" },
);
assert.deepEqual(
  archivePlan.statuses.map((status) => status.id),
  ["todo", "done", "review-ready"],
);
assert.deepEqual(
  archivePlan.repoints.map((repoint) => taskStatusId(repoint.nextContent)),
  ["archived", "archived"],
);

const emptyDeletePlan = deleteStatusMigrationPlan(
  migrationStatuses,
  migrationFiles,
  { statusId: "done" },
);
assert.deepEqual(
  emptyDeletePlan.statuses.map((status) => status.id),
  ["todo", "in-review", "review-ready"],
);
assert.deepEqual(emptyDeletePlan.repoints, []);

console.log("statuses-2-0 smoke passed");
