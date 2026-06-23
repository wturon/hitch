import assert from "node:assert/strict";
import { isPrunableBodyPath } from "../src/daemon";

// Deleting an automation must prune its now-empty `automations/<slug>/` folder,
// the same way task/note folders are pruned. Regression guard: this used to be
// tasks/notes only, so deleting a routine left an empty husk on disk.
assert.equal(isPrunableBodyPath("automations/review-prs/index.md"), true);
assert.equal(isPrunableBodyPath("tasks/some-task/task.md"), true);
assert.equal(isPrunableBodyPath("notes/some-note/index.md"), true);

// Non-body paths under the same folders must NOT trigger a dir prune.
assert.equal(isPrunableBodyPath("automations/review-prs/notes.md"), false);
assert.equal(isPrunableBodyPath("automations/review-prs"), false);
assert.equal(isPrunableBodyPath("automations/a/b/index.md"), false);
assert.equal(isPrunableBodyPath("tasks/some-task/attachments/x.png"), false);
assert.equal(isPrunableBodyPath("hitch.config.json"), false);

console.log("automation prune path smoke passed");
