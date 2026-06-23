import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireProjectAccess,
  requireProjectMemberById,
} from "./authz";

const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;
const EXPIRE_BATCH_LIMIT = 100;

function commandExpiry(now: number): number {
  return now + DEFAULT_COMMAND_TTL_MS;
}

function expirePatch(now: number, reason = "ttl-expired") {
  return {
    status: "expired",
    statusReason: reason,
    updatedAt: now,
  };
}

function isExpiredUnclaimedPending(
  command: {
    status: string;
    expiresAt?: number;
    claimedAt?: number;
  },
  now: number,
) {
  return (
    command.status === "pending" &&
    command.claimedAt === undefined &&
    command.expiresAt !== undefined &&
    command.expiresAt <= now
  );
}

function observableCommand<
  Command extends { status: string; expiresAt?: number; claimedAt?: number },
>(
  command: Command,
  now: number,
) {
  if (!isExpiredUnclaimedPending(command, now)) return command;
  return {
    ...command,
    ...expirePatch(now),
  };
}

async function markAutomationRunForCommand(
  ctx: MutationCtx,
  commandId: Id<"commands">,
  patch: {
    status: "done" | "skipped";
    endedAt: number;
    skipReason?: string;
  },
) {
  const run = await ctx.db
    .query("automationRuns")
    .withIndex("by_command", (q) => q.eq("commandId", commandId))
    .unique();
  if (!run || run.status !== "running") return;
  await ctx.db.patch(run._id, {
    ...patch,
    updatedAt: patch.endedAt,
  });
}

// Enqueue an action for a daemon to run locally (the browser can't open a
// terminal itself). Returns the new command's id so the caller can watch it.
export const enqueueCommand = mutation({
  args: {
    projectId: v.id("projects"),
    host: v.optional(v.string()),
    kind: v.string(),
    harness: v.string(),
    launchId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    path: v.optional(v.string()),
    linkedType: v.optional(
      v.union(v.literal("task"), v.literal("note"), v.literal("automation")),
    ),
    linkedPath: v.optional(v.string()),
    initialPrompt: v.optional(v.string()),
    title: v.optional(v.string()),
    cwd: v.optional(v.string()),
    // start-chat kickoff parameters. Passed to the harness at launch only;
    // never persisted to the task.
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const now = Date.now();
    const { projectId: _projectId, ...command } = args;
    const linkedType = command.linkedType ?? (command.path ? "task" : undefined);
    const linkedPath = command.linkedPath ?? command.path;
    return await ctx.db.insert("commands", {
      ...command,
      linkedType,
      linkedPath,
      projectId: access.project._id,
      status: "pending",
      expiresAt: commandExpiry(now),
      createdAt: now,
      updatedAt: now,
    });
  },
});

// The unclaimed, unexpired pending commands for a project. This is only a queue
// view; daemons must claim a command before executing it.
export const pendingCommands = query({
  args: { projectId: v.id("projects"), deviceToken: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");
    const now = Date.now();
    return await ctx.db
      .query("commands")
      .withIndex("by_project_status_expires", (q) =>
        q
          .eq("projectId", project._id)
          .eq("status", "pending")
          .gt("expiresAt", now),
      )
      .filter((q) => q.eq(q.field("claimedAt"), undefined))
      .collect();
  },
});

export const claimCommand = mutation({
  args: {
    id: v.id("commands"),
    projectId: v.id("projects"),
    deviceToken: v.string(),
    claimedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.id);
    if (!command) return null;
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");
    if (command.projectId !== project._id) throw new Error("Command project mismatch");

    const now = Date.now();
    if (command.status !== "pending") return null;
    if (isExpiredUnclaimedPending(command, now)) {
      await ctx.db.patch(args.id, expirePatch(now));
      return null;
    }
    if (command.claimedAt !== undefined) return null;
    if (command.host && command.host !== args.claimedBy) return null;

    await ctx.db.patch(args.id, {
      claimedAt: now,
      claimedBy: args.claimedBy,
      updatedAt: now,
    });
    return await ctx.db.get(args.id);
  },
});

export const expireStaleCommands = mutation({
  args: { projectId: v.id("projects"), deviceToken: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");

    const now = Date.now();
    const stale = await ctx.db
      .query("commands")
      .withIndex("by_project_status_expires", (q) =>
        q
          .eq("projectId", project._id)
          .eq("status", "pending")
          .lte("expiresAt", now),
      )
      .filter((q) => q.eq(q.field("claimedAt"), undefined))
      .take(EXPIRE_BATCH_LIMIT);
    for (const command of stale) {
      await ctx.db.patch(command._id, expirePatch(now));
      await markAutomationRunForCommand(ctx, command._id, {
        status: "skipped",
        skipReason: "command-expired-before-claim",
        endedAt: now,
      });
    }
    return stale.length;
  },
});

export const expireStaleCommandsForAllProjects = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("commands")
      .withIndex("by_status_expires", (q) =>
        q.eq("status", "pending").lte("expiresAt", now),
      )
      .filter((q) => q.eq(q.field("claimedAt"), undefined))
      .take(EXPIRE_BATCH_LIMIT);
    for (const command of stale) {
      await ctx.db.patch(command._id, expirePatch(now));
      await markAutomationRunForCommand(ctx, command._id, {
        status: "skipped",
        skipReason: "command-expired-before-claim",
        endedAt: now,
      });
    }
    return stale.length;
  },
});

// Mark a command finished (status "done" or "error"), recording the outcome.
// errorCode is a machine-readable failure kind (e.g. "cmux-access-denied") the
// browser uses to show targeted guidance instead of a raw error string.
export const completeCommand = mutation({
  args: {
    id: v.id("commands"),
    status: v.string(),
    result: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    projectId: v.id("projects"),
    deviceToken: v.string(),
    claimedBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.id);
    if (!command) throw new Error("Command not found");
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");
    if (command.projectId !== project._id) throw new Error("Command project mismatch");
    if (command.status === "expired") {
      throw new Error("Command has expired");
    }
    if (
      args.claimedBy !== undefined &&
      command.claimedBy !== undefined &&
      command.claimedBy !== args.claimedBy
    ) {
      throw new Error("Command claim mismatch");
    }
    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      errorCode: args.errorCode,
      updatedAt: now,
    });
    if (args.status !== "done") {
      await markAutomationRunForCommand(ctx, args.id, {
        status: "skipped",
        skipReason: "command-error",
        endedAt: now,
      });
    }
  },
});

// Fetch a single command for the user that enqueued it, so the browser can watch
// how its launch resolved (done, or error with an errorCode to guide the user).
// Returns null if it's gone or belongs to another project.
export const getCommand = query({
  args: { id: v.id("commands"), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectMemberById(ctx, args.projectId);
    const command = await ctx.db.get(args.id);
    if (!command || command.projectId !== project._id) return null;
    return observableCommand(command, Date.now());
  },
});
