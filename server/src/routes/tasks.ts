import { zValidator } from "@hono/zod-validator";
import { and, eq, exists, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv, Db } from "../context.js";
import { projects, tags, tasks, taskTags } from "../db/schema.js";
import { idParam, taskCreate, taskListQuery, taskTagParams, taskUpdate } from "../validation.js";
import { notFound, ownedProject, ownedSection, ownedTag, ownedTask } from "./helpers.js";

// Every task response embeds `tagIds` so the client cache shape is uniform
// and a task_tags change can invalidate plain ["tasks"] keys without a
// follow-up links fetch. One grouped query per response — never N+1.
async function tagLinksByTask(db: Db, taskIds: string[]) {
  const map = new Map<string, { tagId: string; createdAt: Date }[]>();
  if (taskIds.length === 0) return map;
  const links = await db
    .select({
      taskId: taskTags.taskId,
      tagId: taskTags.tagId,
      createdAt: taskTags.createdAt,
    })
    .from(taskTags)
    .where(inArray(taskTags.taskId, taskIds))
    .orderBy(taskTags.createdAt, taskTags.tagId);
  for (const { taskId, tagId, createdAt } of links) {
    const list = map.get(taskId);
    const link = { tagId, createdAt };
    if (list) list.push(link);
    else map.set(taskId, [link]);
  }
  return map;
}

async function tagIdsByTask(db: Db, taskIds: string[]) {
  const links = await tagLinksByTask(db, taskIds);
  return new Map(
    [...links].map(([taskId, rows]) => [taskId, rows.map((row) => row.tagId)]),
  );
}

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
    const tagIds = await tagIdsByTask(
      db,
      rows.map((r) => r.task.id),
    );
    return c.json(rows.map((r) => ({ ...r.task, tagIds: tagIds.get(r.task.id) ?? [] })));
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
    if (body.autoTitleSeed !== undefined && body.autoTitleSeed !== body.title) {
      return c.json({ error: "auto-title seed must match title" }, 400);
    }
    const [row] = await db
      .insert(tasks)
      .values(body)
      .returning();
    // A fresh task can't have links yet — [] keeps the response shape uniform.
    return c.json({ ...row, tagIds: [] as string[] }, 201);
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await ownedTask(c.var.db, c.var.userId, c.req.valid("param").id);
    if (!row) return c.json(notFound, 404);
    const tagIds = await tagIdsByTask(c.var.db, [row.id]);
    return c.json({ ...row, tagIds: tagIds.get(row.id) ?? [] });
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
    if (patch.autoTitleSeed !== undefined) {
      const nextTitle = patch.title ?? existing.title;
      if (patch.autoTitleSeed !== null && patch.autoTitleSeed !== nextTitle) {
        return c.json({ error: "auto-title seed must match title" }, 400);
      }
      updates.autoTitleSeed = patch.autoTitleSeed;
    } else if (patch.title !== undefined && patch.title !== existing.title) {
      // A rename ends the pending request outright. Leaving the old seed would
      // let changing the title back later silently resurrect auto-naming.
      updates.autoTitleSeed = null;
    }

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

    const currentLinks = (await tagLinksByTask(db, [id])).get(id) ?? [];
    const currentTagIds = currentLinks.map((link) => link.tagId);
    const requestedTagIds =
      patch.tagIds === undefined ? currentTagIds : [...new Set(patch.tagIds)];

    // Validate the complete replacement set before opening the transaction.
    // A foreign or missing id is deliberately indistinguishable (404).
    if (patch.tagIds !== undefined && requestedTagIds.length > 0) {
      const ownedTags = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, c.var.userId), inArray(tags.id, requestedTagIds)));
      if (ownedTags.length !== requestedTagIds.length) return c.json(notFound, 404);
    }

    const currentTagSet = new Set(currentTagIds);
    const requestedTagSet = new Set(requestedTagIds);
    const removedTagIds = currentTagIds.filter((tagId) => !requestedTagSet.has(tagId));
    const addedTagIds = requestedTagIds.filter((tagId) => !currentTagSet.has(tagId));
    // Retained links keep their created_at provenance and relative order. New
    // links share the transaction timestamp, so tagId is their deterministic
    // read-order tiebreaker (the same ordering tagLinksByTask applies).
    const persistedTagIds = [
      ...currentTagIds.filter((tagId) => requestedTagSet.has(tagId)),
      ...addedTagIds.slice().sort(),
    ];

    if (
      Object.keys(updates).length === 0 &&
      removedTagIds.length === 0 &&
      addedTagIds.length === 0
    ) {
      return c.json({ ...existing, tagIds: persistedTagIds });
    }

    const row = await db.transaction(async (tx) => {
      let updated = existing;
      if (Object.keys(updates).length > 0) {
        [updated] = await tx.update(tasks).set(updates).where(eq(tasks.id, id)).returning();
      }
      if (patch.tagIds !== undefined) {
        if (removedTagIds.length > 0) {
          await tx
            .delete(taskTags)
            .where(
              and(eq(taskTags.taskId, id), inArray(taskTags.tagId, removedTagIds)),
            );
        }
        if (addedTagIds.length > 0) {
          await tx
            .insert(taskTags)
            .values(addedTagIds.map((tagId) => ({ taskId: id, tagId })))
            .onConflictDoNothing();
        }
      }
      return updated;
    });
    return c.json({ ...row, tagIds: persistedTagIds });
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
