import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Enqueue an action for a daemon to run locally (the browser can't open a
// terminal itself). Returns the new command's id so the caller can watch it.
export const enqueueCommand = mutation({
  args: {
    workspace: v.string(),
    host: v.optional(v.string()),
    kind: v.string(),
    harness: v.string(),
    sessionId: v.string(),
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("commands", {
      ...args,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  },
});

// The pending commands for a workspace. The daemon subscribes to this; as soon
// as it marks one done, it drops out of the result set.
export const pendingCommands = query({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commands")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspace", args.workspace).eq("status", "pending"),
      )
      .collect();
  },
});

// Mark a command finished (status "done" or "error"), recording the outcome.
export const completeCommand = mutation({
  args: {
    id: v.id("commands"),
    status: v.string(),
    result: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      updatedAt: Date.now(),
    });
  },
});
