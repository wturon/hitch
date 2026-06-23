import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "expire stale commands",
  { minutes: 1 },
  internal.commands.expireStaleCommandsForAllProjects,
);

crons.interval(
  "enqueue due automation runs",
  { minutes: 1 },
  internal.automationScheduler.tickDueAutomations,
  {},
);

export default crons;
