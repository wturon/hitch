import assert from "node:assert/strict";

import {
  countTaskStatuses,
  normalizeStatuses,
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

console.log("statuses-2-0 smoke passed");
