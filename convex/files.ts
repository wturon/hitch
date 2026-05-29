import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
  },
  handler: async (ctx, args) => {
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
    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("files", doc);
    }
  },
});

// All files for a workspace (including tombstones, so the daemon can apply
// deletes). The web UI will later filter out deleted rows.
export const listFiles = query({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
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
  },
  handler: async (ctx, args) => {
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
