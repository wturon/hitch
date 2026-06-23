import assert from "node:assert/strict";
import {
  nextRunAfter,
  projectAutomationDefinition,
} from "../../convex/automationDefinitions";

const baseTime = Date.UTC(2026, 5, 23, 12, 2, 10);

const valid = projectAutomationDefinition({
  path: "automations/review-prs/index.md",
  content: `---
name: "Review open PRs"
type: automation
enabled: true
schedule: "15 * * * *"
timezone: "UTC"
harness: codex
model: gpt-5
effort: medium
---
Review open pull requests and leave concise notes.
`,
  deleted: false,
  now: baseTime,
});

assert.ok(valid);
assert.equal(valid.automationPath, "automations/review-prs/index.md");
assert.equal(valid.slug, "review-prs");
assert.equal(valid.name, "Review open PRs");
assert.equal(valid.enabled, true);
assert.equal(valid.schedule, "15 * * * *");
assert.equal(valid.timezone, "UTC");
assert.equal(valid.harness, "codex");
assert.equal(valid.model, "gpt-5");
assert.equal(valid.effort, "medium");
assert.equal(valid.prompt, "Review open pull requests and leave concise notes.");
assert.equal(valid.validationError, undefined);
assert.equal(valid.nextRunAt, Date.UTC(2026, 5, 23, 12, 15, 0));

const disabled = projectAutomationDefinition({
  path: "automations/paused/index.md",
  content: `---
name: Paused
enabled: false
schedule: "*/5 * * * *"
timezone: UTC
---
Do not schedule me.
`,
  deleted: false,
  now: baseTime,
});

assert.ok(disabled);
assert.equal(disabled.enabled, false);
assert.equal(disabled.validationError, undefined);
assert.equal(disabled.nextRunAt, undefined);

const invalid = projectAutomationDefinition({
  path: "automations/bad/index.md",
  content: `---
name: Bad schedule
enabled: true
schedule: nope
timezone: UTC
---
This should not be schedulable.
`,
  deleted: false,
  now: baseTime,
});

assert.ok(invalid);
assert.equal(invalid.enabled, false);
assert.match(invalid.validationError ?? "", /5-field cron/);
assert.equal(invalid.nextRunAt, undefined);

const deleted = projectAutomationDefinition({
  path: "automations/deleted/index.md",
  content: "",
  deleted: true,
  previous: {
    lastScheduledAt: Date.UTC(2026, 5, 23, 10),
    lastRunId: "run-123",
  },
  now: baseTime,
});

assert.ok(deleted);
assert.equal(deleted.deleted, true);
assert.equal(deleted.enabled, false);
assert.equal(deleted.lastScheduledAt, Date.UTC(2026, 5, 23, 10));
assert.equal(deleted.lastRunId, "run-123");

assert.equal(
  nextRunAfter("0 9 * * 1-5", "America/New_York", Date.UTC(2026, 5, 23, 12)),
  Date.UTC(2026, 5, 23, 13),
);
assert.equal(
  projectAutomationDefinition({
    path: "notes/not-automation/index.md",
    content: "",
    deleted: false,
  }),
  null,
);

console.log("automation definition smoke passed");
