import assert from "node:assert/strict";
import { automationRunMatchesLifecycle } from "../../convex/chats";
import type { Id } from "../../convex/_generated/dataModel";

const projectId = "project-1" as Id<"projects">;
const runId = "run-a" as Id<"automationRuns">;

const runA = {
  projectId,
  automationPath: "automations/a/index.md",
  launchId: "launch-a",
  status: "running" as const,
};

assert.equal(
  automationRunMatchesLifecycle(runA, {
    projectId,
    automationRunId: runId,
    launchId: "launch-a",
    linkedType: "automation",
    linkedPath: "automations/a/index.md",
  }),
  true,
);

assert.equal(
  automationRunMatchesLifecycle(runA, {
    projectId,
    automationRunId: runId,
    launchId: "launch-b",
    linkedType: "automation",
    linkedPath: "automations/a/index.md",
  }),
  false,
);

assert.equal(
  automationRunMatchesLifecycle(runA, {
    projectId,
    automationRunId: runId,
    launchId: "launch-a",
    linkedType: "automation",
    linkedPath: "automations/b/index.md",
  }),
  false,
);

assert.equal(
  automationRunMatchesLifecycle(runA, {
    projectId,
    automationRunId: runId,
  }),
  false,
);

console.log("automation run lifecycle smoke passed");
