import { zValidator } from "@hono/zod-validator";
import { and, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { projects, sections } from "../db/schema.js";
import { idParam, sectionCreate, sectionListQuery, sectionUpdate } from "../validation.js";
import { notFound, ownedProject, ownedSection } from "./helpers.js";

export const sectionRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", zValidator("query", sectionListQuery), async (c) => {
    const q = c.req.valid("query");
    const conds: SQL[] = [eq(projects.userId, c.var.userId)];
    if (q.project_id) conds.push(eq(sections.projectId, q.project_id));
    const rows = await c.var.db
      .select({ section: sections })
      .from(sections)
      .innerJoin(projects, eq(sections.projectId, projects.id))
      .where(and(...conds))
      .orderBy(sections.sortOrder);
    return c.json(rows.map((r) => r.section));
  })
  .post("/", zValidator("json", sectionCreate), async (c) => {
    const body = c.req.valid("json");
    const project = await ownedProject(c.var.db, c.var.userId, body.projectId);
    if (!project) return c.json(notFound, 404);
    const [row] = await c.var.db.insert(sections).values(body).returning();
    return c.json(row, 201);
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await ownedSection(c.var.db, c.var.userId, c.req.valid("param").id);
    if (!row) return c.json(notFound, 404);
    return c.json(row);
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", sectionUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const existing = await ownedSection(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    if (Object.keys(patch).length === 0) return c.json(existing);
    const [row] = await c.var.db
      .update(sections)
      .set(patch)
      .where(eq(sections.id, id))
      .returning();
    return c.json(row);
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedSection(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    await c.var.db.delete(sections).where(eq(sections.id, id));
    return c.json({ ok: true });
  });
