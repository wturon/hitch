import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireProjectAccess,
  requireProjectMemberById,
} from "./authz";

// Enqueue an action for a daemon to run locally (the browser can't open a
// terminal itself). Returns the new command's id so the caller can watch it.
export const enqueueCommand = mutation({
  args: {
    projectId: v.id("projects"),
    host: v.optional(v.string()),
    kind: v.string(),
    harness: v.string(),
    sessionId: v.optional(v.string()),
    path: v.optional(v.string()),
    initialPrompt: v.optional(v.string()),
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const now = Date.now();
    const { projectId: _projectId, ...command } = args;
    return await ctx.db.insert("commands", {
      ...command,
      projectId: access.project._id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  },
});

// The pending commands for a project. The daemon subscribes to this; as soon as
// it marks one done, it drops out of the result set.
export const pendingCommands = query({
  args: { projectId: v.id("projects"), deviceToken: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");
    return await ctx.db
      .query("commands")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", project._id).eq("status", "pending"),
      )
      .collect();
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
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      errorCode: args.errorCode,
      updatedAt: Date.now(),
    });
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
    return command;
  },
});
