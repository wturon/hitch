import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess } from "./authz";

// Image attachments live in Convex file storage (blobs), not the text `files`
// table — see schema.ts. The renderer is the sole upload ingress (paste/drop in
// the task editor); the daemon is download-only. Access mirrors files.ts:
// gated by projectAccess + an optional deviceToken (the daemon path).

// Hand the renderer a short-lived upload URL it POSTs the image bytes to. The
// POST returns a storageId, which the renderer then hands to registerAttachment.
export const generateUploadUrl = mutation({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.storage.generateUploadUrl();
  },
});

// Insert or update the attachment row by its (projectId, path) key. The renderer
// calls this BEFORE the markdown reference lands in the body, so a failure
// leaves a harmless orphan row rather than a dangling link. A delete is just an
// upsert with deleted: true (a tombstone) so the daemon removes the local file.
export const registerAttachment = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    storageId: v.id("_storage"),
    hash: v.string(),
    contentType: v.string(),
    size: v.number(),
    deleted: v.optional(v.boolean()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.path),
      )
      .unique();

    const doc = {
      projectId: access.project._id,
      path: args.path,
      storageId: args.storageId,
      hash: args.hash,
      contentType: args.contentType,
      size: args.size,
      deleted: args.deleted ?? false,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("attachments", doc);
    }
  },
});

// Tombstone an attachment row by its (projectId, path) key — a no-op if the row
// doesn't exist. Used by the task-delete cascade: the caller knows the path but
// not the storageId, so it can't go through registerAttachment. The daemon's
// listAttachments subscription removes the local file.
export const tombstoneAttachment = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.path),
      )
      .unique();
    if (existing && !existing.deleted) {
      await ctx.db.patch(existing._id, { deleted: true, updatedAt: Date.now() });
    }
  },
});

// All attachment rows for a project, each with a freshly-signed download URL
// (null once a blob is GC'd). Includes tombstones so the daemon can apply
// deletes; the renderer filters them out. Both the renderer's imagePreviewHandler
// and the daemon's downloader consume the `url` here — keeping URL resolution in
// one place avoids a second round-trip per image.
export const listAttachments = query({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    return await Promise.all(
      rows.map(async (row) => ({
        ...row,
        url: row.deleted ? null : await ctx.storage.getUrl(row.storageId),
      })),
    );
  },
});
