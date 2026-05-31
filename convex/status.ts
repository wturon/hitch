import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDaemonToken, requireWorkspaceMemberBySlug } from "./authz";

// Upsert a daemon's heartbeat. The daemon calls this on startup and on an
// interval; lastSeen is stamped server-side to avoid clock skew between
// machines. Keyed by (workspace, hostname) so one row per machine.
export const heartbeat = mutation({
  args: {
    workspace: v.string(),
    hostname: v.string(),
    sources: v.array(v.string()),
    daemonToken: v.string(),
  },
  handler: async (ctx, args) => {
    await requireDaemonToken(ctx, args.workspace, args.daemonToken);
    const existing = await ctx.db
      .query("daemons")
      .withIndex("by_key", (q) =>
        q.eq("workspace", args.workspace).eq("hostname", args.hostname),
      )
      .unique();

    const { daemonToken: _daemonToken, ...heartbeat } = args;
    const doc = { ...heartbeat, lastSeen: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("daemons", doc);
    }
  },
});

// All daemons for a workspace. The board uses lastSeen to show which machines
// are currently connected (e.g. "seen within the last 30s") and what each is
// watching.
export const listDaemons = query({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
    await requireWorkspaceMemberBySlug(ctx, args.workspace);
    return await ctx.db
      .query("daemons")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .collect();
  },
});
