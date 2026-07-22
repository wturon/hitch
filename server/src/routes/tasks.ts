import { zValidator } from "@hono/zod-validator";
import { and, eq, exists, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { projects, tasks, taskTags } from "../db/schema.js";
import { idParam, taskCreate, taskListQuery, taskTagParams, taskUpdate } from "../validation.js";
import { notFound, ownedProject, ownedSection, ownedTag, ownedTask } from "./helpers.js";

export const taskRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", zValidator("query", taskListQuery), async (c) => {
    const q = c.req.valid("query");
    const db = c.var.db;
    const conds: SQL[] = [eq(projects.userId, c.var.userId)];
    if (q.project_id) conds.push(eq(tasks.projectId, q.project_id));
    if (q.section_id) conds.push(eq(tasks.sectionId, q.section_id));
    if (q.status) conds.push(eq(tasks.status, q.status));
    if (q.tag_id) {
      conds.push(
        exists(
          db
            .select()
            .from(taskTags)
            .where(and(eq(taskTags.taskId, tasks.id), eq(taskTags.tagId, q.tag_id))),
        ),
      );
    }
    const rows = await db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(...conds))
      .orderBy(tasks.sortOrder);
    return c.json(rows.map((r) => r.task));
  })
  .post("/", zValidator("json", taskCreate), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const project = await ownedProject(db, c.var.userId, body.projectId);
    if (!project) return c.json(notFound, 404);
    if (body.sectionId != null) {
      const section = await ownedSection(db, c.var.userId, body.sectionId);
      if (!section) return c.json(notFound, 404);
      if (section.projectId !== body.projectId) {
        return c.json({ error: "section does not belong to project" }, 400);
      }
    }
    const [row] = await db.insert(tasks).values(body).returning();
    return c.json(row, 201);
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await ownedTask(c.var.db, c.var.userId, c.req.valid("param").id);
    if (!row) return c.json(notFound, 404);
    return c.json(row);
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", taskUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = c.var.db;
    const existing = await ownedTask(db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);

    const updates: Partial<typeof tasks.$inferInsert> = {};
    if (patch.title !== undefined) updates.title = patch.title;
    // VERBATIM passthrough — never trim/transform the body.
    if (patch.body !== undefined) updates.body = patch.body;
    if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;

    let targetProjectId = existing.projectId;
    if (patch.projectId !== undefined) {
      const project = await ownedProject(db, c.var.userId, patch.projectId);
      if (!project) return c.json(notFound, 404);
      updates.projectId = patch.projectId;
      targetProjectId = patch.projectId;
      // Moving projects clears the section unless a new one comes along.
      if (patch.sectionId === undefined && patch.projectId !== existing.projectId) {
        updates.sectionId = null;
      }
    }
    if (patch.sectionId !== undefined) {
      if (patch.sectionId === null) {
        updates.sectionId = null;
      } else {
        const section = await ownedSection(db, c.var.userId, patch.sectionId);
        if (!section) return c.json(notFound, 404);
        if (section.projectId !== targetProjectId) {
          return c.json({ error: "section does not belong to task's project" }, 400);
        }
        updates.sectionId = patch.sectionId;
      }
    }
    // Status transitions own completed_at: done sets it, reopening clears it.
    // A no-op status write keeps the original completion time.
    if (patch.status !== undefined && patch.status !== existing.status) {
      updates.status = patch.status;
      updates.completedAt = patch.status === "done" ? new Date() : null;
    }

    if (Object.keys(updates).length === 0) return c.json(existing);
    const [row] = await db.update(tasks).set(updates).where(eq(tasks.id, id)).returning();
    return c.json(row);
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedTask(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    await c.var.db.delete(tasks).where(eq(tasks.id, id));
    return c.json({ ok: true });
  })
  .post("/:id/tags/:tagId", zValidator("param", taskTagParams), async (c) => {
    const { id, tagId } = c.req.valid("param");
    const db = c.var.db;
    const task = await ownedTask(db, c.var.userId, id);
    if (!task) return c.json(notFound, 404);
    const tag = await ownedTag(db, c.var.userId, tagId);
    if (!tag) return c.json(notFound, 404);
    // Idempotent: re-adding an existing link is a no-op, not an error.
    await db.insert(taskTags).values({ taskId: id, tagId }).onConflictDoNothing();
    return c.json({ ok: true }, 201);
  })
  .delete("/:id/tags/:tagId", zValidator("param", taskTagParams), async (c) => {
    const { id, tagId } = c.req.valid("param");
    const db = c.var.db;
    const task = await ownedTask(db, c.var.userId, id);
    if (!task) return c.json(notFound, 404);
    const deleted = await db
      .delete(taskTags)
      .where(and(eq(taskTags.taskId, id), eq(taskTags.tagId, tagId)))
      .returning();
    if (deleted.length === 0) return c.json(notFound, 404);
    return c.json({ ok: true });
  });
