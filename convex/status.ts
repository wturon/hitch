import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess, requireProjectMemberBySlug } from "./authz";

// Upsert a daemon's heartbeat. The daemon calls this on startup and on an
// interval; lastSeen is stamped server-side to avoid clock skew between
// machines. Keyed by (projectId, hostname) so one row per machine.
export const heartbeat = mutation({
  args: {
    project: v.string(),
    hostname: v.string(),
    deviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(
      ctx,
      args.project,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");
    const existing = await ctx.db
      .query("daemons")
      .withIndex("by_key", (q) =>
        q.eq("projectId", project._id).eq("hostname", args.hostname),
      )
      .unique();

    const doc = { projectId: project._id, hostname: args.hostname, lastSeen: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("daemons", doc);
    }
  },
});

// All daemons for a project. The board uses lastSeen to show which machines are
// currently connected.
export const listDaemons = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberBySlug(ctx, args.project);
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("daemons")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
  },
});
