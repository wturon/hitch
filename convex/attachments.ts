import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireProjectAccess } from "./authz";

// Image attachments live in Convex file storage (blobs), not the text `files`
// table — see schema.ts. The renderer is the sole upload ingress (paste/drop in
// the task editor); the daemon is download-only. Access mirrors files.ts:
// gated by projectAccess + an optional deviceToken (the daemon path).

type AttachmentCopySource = {
  path: string;
  storageId: Id<"_storage">;
  hash: string;
  contentType: string;
  size: number;
};

type CopiedAttachment = AttachmentCopySource;

const TASK_BODY_RE = /^tasks\/([^/]+)\/task\.md$/;
const TASK_ATTACHMENT_PREFIX_RE = /^tasks\/[^/]+\/attachments\/$/;

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

export const listAttachmentsForCopy = internalQuery({
  args: {
    projectId: v.id("projects"),
    prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId);
    if (!access.project) throw new Error("Project does not exist");
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    return rows.filter(
      (row) => !row.deleted && row.path.startsWith(args.prefix),
    );
  },
});

export const publishCopiedTask = internalMutation({
  args: {
    projectId: v.id("projects"),
    task: v.object({
      path: v.string(),
      content: v.string(),
      hash: v.string(),
    }),
    attachments: v.array(
      v.object({
        path: v.string(),
        storageId: v.id("_storage"),
        hash: v.string(),
        contentType: v.string(),
        size: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(ctx, args.projectId);
    if (!access.project) throw new Error("Project does not exist");

    const existingTask = await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.task.path),
      )
      .unique();
    const taskDoc = {
      projectId: access.project._id,
      path: args.task.path,
      content: args.task.content,
      hash: args.task.hash,
      deleted: false,
      updatedAt: Date.now(),
    };
    if (existingTask) {
      await ctx.db.patch(existingTask._id, taskDoc);
    } else {
      await ctx.db.insert("files", taskDoc);
    }

    for (const row of args.attachments) {
      const existing = await ctx.db
        .query("attachments")
        .withIndex("by_key", (q) =>
          q.eq("projectId", access.project._id).eq("path", row.path),
        )
        .unique();

      const doc = {
        projectId: access.project._id,
        path: row.path,
        storageId: row.storageId,
        hash: row.hash,
        contentType: row.contentType,
        size: row.size,
        deleted: false,
        updatedAt: Date.now(),
      };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
      } else {
        await ctx.db.insert("attachments", doc);
      }
    }
  },
});

export const duplicateTaskWithAttachments = action({
  args: {
    projectId: v.id("projects"),
    fromPrefix: v.string(),
    taskPath: v.string(),
    taskContent: v.string(),
    taskHash: v.string(),
  },
  handler: async (ctx, args): Promise<{ copied: number }> => {
    const taskMatch = args.taskPath.match(TASK_BODY_RE);
    if (!taskMatch) throw new Error("Duplicated task path must be a task body");
    if (!TASK_ATTACHMENT_PREFIX_RE.test(args.fromPrefix)) {
      throw new Error("Source prefix must target a task attachment folder");
    }
    const toPrefix = `tasks/${taskMatch[1]}/attachments/`;
    if (args.fromPrefix === toPrefix) {
      throw new Error(
        "Attachment copy requires distinct source and destination prefixes",
      );
    }

    const rows = await ctx.runQuery(internal.attachments.listAttachmentsForCopy, {
      projectId: args.projectId,
      prefix: args.fromPrefix,
    });

    const copiedRows: CopiedAttachment[] = [];
    try {
      for (const row of rows) {
        const name = row.path.slice(args.fromPrefix.length);
        if (!name || name.includes("/")) {
          throw new Error(`Unexpected attachment path: ${row.path}`);
        }

        const blob = await ctx.storage.get(row.storageId);
        if (!blob) {
          throw new Error(`Attachment blob is missing for ${row.path}`);
        }

        copiedRows.push({
          path: `${toPrefix}${name}`,
          storageId: await ctx.storage.store(blob, { sha256: row.hash }),
          hash: row.hash,
          contentType: row.contentType,
          size: row.size,
        });
      }

      await ctx.runMutation(internal.attachments.publishCopiedTask, {
        projectId: args.projectId,
        task: {
          path: args.taskPath,
          content: args.taskContent,
          hash: args.taskHash,
        },
        attachments: copiedRows,
      });
    } catch (err) {
      await Promise.all(
        copiedRows.map((row) =>
          ctx.storage.delete(row.storageId).catch((deleteErr) => {
            console.warn(
              `Failed to clean up copied attachment ${row.path}: ${String(deleteErr)}`,
            );
          }),
        ),
      );
      throw err;
    }

    return { copied: copiedRows.length };
  },
});
