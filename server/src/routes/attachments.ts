import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { uuidv7 } from "uuidv7";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { attachments } from "../db/schema.js";
import { attachmentCreate, attachmentListQuery, idParam } from "../validation.js";
import { notFound, ownedAttachment, ownedComment, ownedTask } from "./helpers.js";

// Attachments presigned flow (see docs/v2-prd.md "Blobs"). The lifecycle:
//   POST /            → row state='pending' + presigned PUT url (client uploads)
//   POST /:id/finalize → HEAD the object, enforce the size cap, state='finalized'
//   GET  /:id/download → JSON {url} with a presigned GET
// Keys live in the DB, URLs never do — every URL is minted on demand.

// S3 keys are attachments/<uuid>/<sanitized-filename>; the uuid guarantees
// uniqueness, the filename is cosmetic (nice downloads) so sanitizing it is
// NOT a capture-text violation — the verbatim filename lives on the row.
const sanitizeFilename = (name: string) => {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
  return cleaned || "file";
};

export const attachmentRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", zValidator("query", attachmentListQuery), async (c) => {
    const q = c.req.valid("query");
    const db = c.var.db;
    if (q.task_id !== undefined) {
      const task = await ownedTask(db, c.var.userId, q.task_id);
      if (!task) return c.json(notFound, 404);
    } else {
      const comment = await ownedComment(db, c.var.userId, q.comment_id as string);
      if (!comment) return c.json(notFound, 404);
    }
    const rows = await db
      .select()
      .from(attachments)
      .where(
        q.task_id !== undefined
          ? eq(attachments.taskId, q.task_id)
          : eq(attachments.commentId, q.comment_id as string),
      )
      .orderBy(attachments.createdAt);
    return c.json(rows);
  })
  .post("/", zValidator("json", attachmentCreate), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const storage = c.var.storage;
    if (body.taskId !== undefined) {
      const task = await ownedTask(db, c.var.userId, body.taskId);
      if (!task) return c.json(notFound, 404);
    } else {
      const comment = await ownedComment(db, c.var.userId, body.commentId as string);
      if (!comment) return c.json(notFound, 404);
    }
    // Fail fast on an honestly-declared oversize upload; finalize re-checks
    // the REAL size, so this is UX, not enforcement.
    if (body.size > storage.maxUploadBytes) {
      return c.json(
        { error: `size ${body.size} exceeds the ${storage.maxUploadBytes}-byte upload cap` },
        400,
      );
    }
    // Id generated here (not by the column default) because the S3 key
    // embeds it.
    const id = uuidv7();
    const key = `attachments/${id}/${sanitizeFilename(body.filename)}`;
    const [row] = await db
      .insert(attachments)
      .values({ ...body, id, key })
      .returning();
    const uploadUrl = await storage.presignUpload(key, body.mime, body.size);
    return c.json({ attachment: row, uploadUrl }, 201);
  })
  .post("/:id/finalize", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const storage = c.var.storage;
    const existing = await ownedAttachment(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    // Idempotent: re-finalizing a finalized attachment is a no-op.
    if (existing.state === "finalized") return c.json(existing);

    // Size-cap enforcement lives HERE — presigned URLs can't enforce it (PRD).
    const actualSize = await storage.headSize(existing.key);
    if (actualSize === undefined) {
      return c.json({ error: "object has not been uploaded" }, 400);
    }
    if (actualSize !== existing.size || actualSize > storage.maxUploadBytes) {
      // Reject AND remove the offending object so nothing unaccounted-for
      // lingers in the bucket. Row stays pending — the client can retry the
      // whole create/upload/finalize cycle.
      try {
        await storage.deleteObject(existing.key);
      } catch (error) {
        console.error(`[attachments] failed to delete rejected object ${existing.key}:`, error);
      }
      return c.json(
        {
          error:
            `uploaded object is ${actualSize} bytes; declared ${existing.size}, ` +
            `cap ${storage.maxUploadBytes}`,
        },
        400,
      );
    }
    const [row] = await c.var.db
      .update(attachments)
      .set({ state: "finalized" })
      .where(eq(attachments.id, id))
      .returning();
    return c.json(row);
  })
  // JSON {url} instead of a 302 on purpose: friendlier for the Electron
  // client (fetch the URL when it actually needs the bytes, no redirect
  // handling in the typed client).
  .get("/:id/download", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedAttachment(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    if (existing.state !== "finalized") {
      return c.json({ error: "attachment is not finalized" }, 400);
    }
    const url = await c.var.storage.presignDownload(existing.key);
    return c.json({ url });
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedAttachment(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    await c.var.db.delete(attachments).where(eq(attachments.id, id));
    // Best-effort object delete: an S3 orphan is accepted (schema comment),
    // a dangling DB row is not — so the row goes first and this never errors.
    try {
      await c.var.storage.deleteObject(existing.key);
    } catch (error) {
      console.error(`[attachments] failed to delete object ${existing.key}:`, error);
    }
    return c.json({ ok: true });
  });
