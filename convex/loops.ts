import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireProjectAccess } from "./authz";

// Create a loop run record (status usually starts "running" or "skipped").
// Called by the daemon (deviceToken) when a scheduled or manual run begins, or
// when a tick is skipped. Returns the new run id so the daemon can patch it as
// the run progresses.
export const createRun = mutation({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
    loopPath: v.string(),
    host: v.string(),
    status: v.string(),
    reason: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    triggerExitCode: v.optional(v.number()),
    triggerStdout: v.optional(v.string()),
    triggerStderr: v.optional(v.string()),
    harness: v.string(),
    model: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    chatPid: v.optional(v.number()),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const now = Date.now();
    const { projectId: _projectId, deviceToken: _deviceToken, ...rest } = args;
    const id = await ctx.db.insert("loopRuns", {
      ...rest,
      projectId: access.project._id,
      createdAt: now,
      updatedAt: now,
    });
    // Retention: skipped-class runs (no linked chat, low value) accumulate fast
    // for short-interval loops. Keep the most recent N per loop and drop the rest
    // beyond a max age. `ran`/`running` records (which carry a chat) are never
    // pruned here. See the PRD "keep last N or N days, compact the rest".
    await pruneSkipped(ctx, access.project._id, args.loopPath, now);
    return id;
  },
});

const SKIP_CLASS = new Set([
  "skipped",
  "trigger-error",
  "launch-error",
  "timed-out",
  "interrupted",
]);
const RETAIN_SKIPPED = 20; // keep this many skipped-class runs per loop
const RETAIN_MS = 14 * 24 * 60 * 60 * 1000; // …and drop any older than 14 days

async function pruneSkipped(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  loopPath: string,
  now: number,
): Promise<void> {
  const runs = await ctx.db
    .query("loopRuns")
    .withIndex("by_loop", (q) =>
      q.eq("projectId", projectId).eq("loopPath", loopPath),
    )
    .order("desc")
    .collect();
  const skipped = runs.filter((r) => SKIP_CLASS.has(r.status));
  let kept = 0;
  for (const run of skipped) {
    kept++;
    if (kept > RETAIN_SKIPPED || run.startedAt < now - RETAIN_MS) {
      await ctx.db.delete(run._id);
    }
  }
}

// Patch a loop run record as it progresses (link a session, settle status,
// write a summary, etc.). Called by the daemon.
export const patchRun = mutation({
  args: {
    id: v.id("loopRuns"),
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
    status: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    triggerExitCode: v.optional(v.number()),
    triggerStdout: v.optional(v.string()),
    triggerStderr: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    chatPid: v.optional(v.number()),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const run = await ctx.db.get(args.id);
    if (!run) throw new Error("Run not found");
    if (run.projectId !== access.project._id)
      throw new Error("Run project mismatch");
    const { id, projectId: _projectId, deviceToken: _deviceToken, ...patch } =
      args;
    // Strip undefined so we never clobber set fields with absent args.
    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) fields[k] = val;
    }
    await ctx.db.patch(id, fields);
  },
});

// All run records for a project, newest first. Powers the Activity tab.
export const listRunsByProject = query({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const runs = await ctx.db
      .query("loopRuns")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .order("desc")
      .take(args.limit ?? 200);
    return runs;
  },
});

// Run records for one loop, newest first. Powers a loop's Run history list.
export const listRunsByLoop = query({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
    loopPath: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("loopRuns")
      .withIndex("by_loop", (q) =>
        q.eq("projectId", access.project._id).eq("loopPath", args.loopPath),
      )
      .order("desc")
      .take(args.limit ?? 50);
  },
});

// The latest run for each loop in the project, keyed by loopPath. The daemon
// uses this to recompute "next due" from cron + last run; the UI uses it for
// the card's last-run / countdown. Cheap enough at V1 scale (collect + reduce).
export const latestRunPerLoop = query({
  args: { projectId: v.id("projects"), deviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const runs = await ctx.db
      .query("loopRuns")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .order("desc")
      .collect();
    const latest: Record<string, (typeof runs)[number]> = {};
    for (const run of runs) {
      // runs are newest-first, so the first one seen per loop is the latest.
      if (!latest[run.loopPath]) latest[run.loopPath] = run;
    }
    return latest;
  },
});

// Currently-running run records on a given host. The daemon's concurrency=skip
// fallback ("is a run already active for this loop on this host?") and reboot
// recovery (mark stuck `running` → `interrupted`) read this.
export const runningRuns = query({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
    host: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const runs = await ctx.db
      .query("loopRuns")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", access.project._id).eq("status", "running"),
      )
      .collect();
    return args.host ? runs.filter((r) => r.host === args.host) : runs;
  },
});
