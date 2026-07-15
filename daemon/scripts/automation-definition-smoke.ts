import assert from "node:assert/strict";
import { projectAutomationDefinition } from "../../convex/automationDefinitions";
import {
  cronFromPreset,
  nextRunAfter,
  nextRunForScheduleState,
  scheduleToEnglish,
} from "../../convex/automationSchedules";

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
assert.equal(valid.scheduleDescription, "Hourly at :15");
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
assert.equal(disabled.scheduleDescription, "Every 5 minutes");

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
assert.equal(invalid.scheduleDescription, "");

const blankPrompt = projectAutomationDefinition({
  path: "automations/blank-prompt/index.md",
  content: `---
name: Blank prompt
enabled: true
schedule: "0 9 * * *"
timezone: UTC
---
${"   "}
`,
  deleted: false,
  now: baseTime,
});

assert.ok(blankPrompt);
assert.equal(blankPrompt.enabled, false);
assert.match(blankPrompt.validationError ?? "", /prompt is required/);
assert.equal(blankPrompt.nextRunAt, undefined);
assert.equal(blankPrompt.prompt, "");

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
assert.equal(deleted.scheduleDescription, "");
assert.equal(deleted.lastScheduledAt, Date.UTC(2026, 5, 23, 10));
assert.equal(deleted.lastRunId, "run-123");

assert.equal(cronFromPreset({ kind: "daily", hour: 9, minute: 30 }), "30 9 * * *");
assert.equal(
  cronFromPreset({ kind: "weekly", dayOfWeek: 2, hour: 14, minute: 5 }),
  "5 14 * * 2",
);
assert.equal(
  cronFromPreset({ kind: "weekdays", hour: 9, minute: 0 }),
  "0 9 * * 1-5",
);
assert.equal(cronFromPreset({ kind: "hourly", minute: 15 }), "15 * * * *");
assert.equal(
  cronFromPreset({ kind: "custom", cron: "*/20   8-17  * * 1-5" }),
  "*/20 8-17 * * 1-5",
);
assert.throws(
  () => cronFromPreset({ kind: "hourly", minute: 60 }),
  /minute must be an integer/,
);
assert.equal(scheduleToEnglish("30 9 * * *"), "Daily at 9:30 AM");
assert.equal(
  scheduleToEnglish("0 9 * * 1-5"),
  "Every weekday at 9:00 AM",
);
assert.equal(
  scheduleToEnglish("5 14 * * 2"),
  "Weekly on Tuesday at 2:05 PM",
);
assert.equal(scheduleToEnglish("15 * * * *"), "Hourly at :15");
assert.equal(
  nextRunAfter("0 9 * * 1-5", "America/New_York", Date.UTC(2026, 5, 23, 12)),
  Date.UTC(2026, 5, 23, 13),
);
assert.equal(
  nextRunAfter("0 9 * * 1-5", "America/New_York", Date.UTC(2026, 5, 26, 14)),
  Date.UTC(2026, 5, 29, 13),
);
assert.equal(
  nextRunAfter("15 * * * *", "UTC", Date.UTC(2026, 5, 23, 12, 15)),
  Date.UTC(2026, 5, 23, 13, 15),
);
assert.equal(
  nextRunAfter("30 2 * * *", "America/New_York", Date.UTC(2026, 2, 7, 8)),
  Date.UTC(2026, 2, 9, 6, 30),
);
assert.equal(
  nextRunAfter("15 * * * *", "UTC", Date.UTC(2026, 5, 23, 12, 16)),
  Date.UTC(2026, 5, 23, 13, 15),
);
assert.equal(
  nextRunForScheduleState(
    "15 * * * *",
    "UTC",
    true,
    Date.UTC(2026, 5, 23, 12, 15),
  ),
  Date.UTC(2026, 5, 23, 13, 15),
);
assert.equal(
  nextRunForScheduleState(
    "15 * * * *",
    "UTC",
    false,
    Date.UTC(2026, 5, 23, 12, 15),
  ),
  undefined,
);
assert.throws(() => nextRunAfter("99 * * * *", "UTC", baseTime), /out of range/);
assert.equal(
  projectAutomationDefinition({
    path: "tasks/not-automation/task.md",
    content: "",
    deleted: false,
  }),
  null,
);

console.log("automation definition smoke passed");
