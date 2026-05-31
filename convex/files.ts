import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireWorkspaceAccess } from "./authz";

// Insert or update a file by its (workspace, source, path) key.
// A delete is just an upsert with deleted: true (a tombstone) so other
// machines learn to remove the file locally.
export const upsertFile = mutation({
  args: {
    workspace: v.string(),
    source: v.string(),
    path: v.string(),
    content: v.string(),
    hash: v.string(),
    deleted: v.boolean(),
    daemonToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspace, args.daemonToken);
    const existing = await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q
          .eq("workspace", args.workspace)
          .eq("source", args.source)
          .eq("path", args.path),
      )
      .unique();

    const doc = { ...args, updatedAt: Date.now() };
    const { daemonToken: _daemonToken, ...fileDoc } = doc;
    if (existing) {
      await ctx.db.patch(existing._id, fileDoc);
    } else {
      await ctx.db.insert("files", fileDoc);
    }
  },
});

// All files for a workspace (including tombstones, so the daemon can apply
// deletes). The web UI will later filter out deleted rows.
export const listFiles = query({
  args: { workspace: v.string(), daemonToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspace, args.daemonToken);
    return await ctx.db
      .query("files")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .collect();
  },
});

// A single file by its (workspace, source, path) key. Returns null if missing.
// For the board's detail view and targeted reads.
export const getFile = query({
  args: {
    workspace: v.string(),
    source: v.string(),
    path: v.string(),
    daemonToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceAccess(ctx, args.workspace, args.daemonToken);
    return await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q
          .eq("workspace", args.workspace)
          .eq("source", args.source)
          .eq("path", args.path),
      )
      .unique();
  },
});
