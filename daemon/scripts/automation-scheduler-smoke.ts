import assert from "node:assert/strict";
import { planSchedulerTick } from "../../convex/automationScheduler";

const now = Date.UTC(2026, 5, 23, 12, 0, 0);

const dueEnabled = {
  automationPath: "automations/due/index.md",
  enabled: true,
  deleted: false,
  validationError: undefined,
  schedule: "0 * * * *",
  timezone: "UTC",
  nextRunAt: now,
};

const plan = planSchedulerTick(
  [
    dueEnabled,
    {
      automationPath: "automations/not-due/index.md",
      enabled: true,
      deleted: false,
      validationError: undefined,
      schedule: "0 * * * *",
      timezone: "UTC",
      nextRunAt: now + 60_000,
    },
    {
      automationPath: "automations/disabled/index.md",
      enabled: false,
      deleted: false,
      validationError: undefined,
      schedule: "0 * * * *",
      timezone: "UTC",
      nextRunAt: now,
    },
    {
      automationPath: "automations/deleted/index.md",
      enabled: true,
      deleted: true,
      validationError: undefined,
      schedule: "0 * * * *",
      timezone: "UTC",
      nextRunAt: now,
    },
    {
      automationPath: "automations/invalid/index.md",
      enabled: true,
      deleted: false,
      validationError: "bad schedule",
      schedule: "0 * * * *",
      timezone: "UTC",
      nextRunAt: now,
    },
  ],
  new Set(),
  now,
);

assert.deepEqual(plan, [
  {
    kind: "enqueue",
    automationPath: "automations/due/index.md",
    scheduledFor: now,
    nextRunAt: now + 60 * 60 * 1000,
  },
]);

const overlapPlan = planSchedulerTick(
  [dueEnabled],
  new Set(["automations/due/index.md"]),
  now,
);

assert.deepEqual(overlapPlan, [
  {
    kind: "skip",
    reason: "overlap",
    automationPath: "automations/due/index.md",
    scheduledFor: now,
    nextRunAt: now + 60 * 60 * 1000,
  },
]);

console.log("automation scheduler smoke passed");
