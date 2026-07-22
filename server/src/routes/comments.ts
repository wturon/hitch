import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { comments } from "../db/schema.js";
import { commentCreate, commentListQuery, commentUpdate, idParam } from "../validation.js";
import { notFound, ownedAssignment, ownedComment, ownedTask } from "./helpers.js";

export const commentRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", zValidator("query", commentListQuery), async (c) => {
    const { task_id: taskId } = c.req.valid("query");
    const task = await ownedTask(c.var.db, c.var.userId, taskId);
    if (!task) return c.json(notFound, 404);
    const rows = await c.var.db
      .select()
      .from(comments)
      .where(eq(comments.taskId, taskId))
      .orderBy(comments.createdAt);
    return c.json(rows);
  })
  .post("/", zValidator("json", commentCreate), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const task = await ownedTask(db, c.var.userId, body.taskId);
    if (!task) return c.json(notFound, 404);
    if (body.assignmentId !== undefined) {
      const assignment = await ownedAssignment(db, c.var.userId, body.assignmentId);
      if (!assignment) return c.json(notFound, 404);
      if (assignment.taskId !== body.taskId) {
        return c.json({ error: "assignment does not belong to task" }, 400);
      }
    }
    const [row] = await db.insert(comments).values(body).returning();
    return c.json(row, 201);
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", commentUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const existing = await ownedComment(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    const [row] = await c.var.db
      .update(comments)
      .set({ body: patch.body })
      .where(eq(comments.id, id))
      .returning();
    return c.json(row);
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedComment(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    await c.var.db.delete(comments).where(eq(comments.id, id));
    return c.json({ ok: true });
  });
