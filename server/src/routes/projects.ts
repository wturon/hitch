import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { projects } from "../db/schema.js";
import { idParam, projectCreate, projectUpdate } from "../validation.js";
import { notFound, ownedProject } from "./helpers.js";

export const projectRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const rows = await c.var.db
      .select()
      .from(projects)
      .where(eq(projects.userId, c.var.userId))
      .orderBy(projects.sortOrder);
    return c.json(rows);
  })
  .post("/", zValidator("json", projectCreate), async (c) => {
    const body = c.req.valid("json");
    const [row] = await c.var.db
      .insert(projects)
      .values({ ...body, userId: c.var.userId })
      .returning();
    return c.json(row, 201);
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await ownedProject(c.var.db, c.var.userId, c.req.valid("param").id);
    if (!row) return c.json(notFound, 404);
    return c.json(row);
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", projectUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const existing = await ownedProject(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    if (Object.keys(patch).length === 0) return c.json(existing);
    const [row] = await c.var.db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, id))
      .returning();
    return c.json(row);
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedProject(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    await c.var.db.delete(projects).where(eq(projects.id, id));
    return c.json({ ok: true });
  });
