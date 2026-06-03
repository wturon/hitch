import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess } from "./authz";

// Insert or update a file by its (projectId, path) key. A delete is just an
// upsert with deleted: true (a tombstone) so other machines learn to remove the
// file locally.
export const upsertFile = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
    hash: v.string(),
    deleted: v.boolean(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId, args.deviceToken);
    if (!access.project) throw new Error("Project does not exist");
    const existing = await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.path),
      )
      .unique();

    const doc = {
      projectId: access.project._id,
      path: args.path,
      content: args.content,
      hash: args.hash,
      deleted: args.deleted,
      updatedAt: Date.now(),
    };
    if (existing) {
      if (existing.hash === args.hash && existing.deleted === args.deleted) {
        return;
      }
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("files", doc);
    }
  },
});

// All files for a project (including tombstones, so the daemon can apply
// deletes). The desktop UI filters out deleted rows.
export const listFiles = query({
  args: { projectId: v.id("projects"), deviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId, args.deviceToken);
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
  },
});

// A single file by its (projectId, path) key. Returns null if missing.
export const getFile = query({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId, args.deviceToken);
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.path),
      )
      .unique();
  },
});
