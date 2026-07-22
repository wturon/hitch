import { zValidator } from "@hono/zod-validator";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { tags } from "../db/schema.js";
import { idParam, tagCreate, tagUpdate } from "../validation.js";
import { notFound, ownedTag } from "./helpers.js";

export const tagRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const rows = await c.var.db
      .select()
      .from(tags)
      .where(eq(tags.userId, c.var.userId))
      .orderBy(tags.name);
    return c.json(rows);
  })
  .post("/", zValidator("json", tagCreate), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    // Pre-check the unique-per-user name for a friendly 409 (the DB unique
    // index still backstops races).
    const [duplicate] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, c.var.userId), eq(tags.name, body.name)));
    if (duplicate) return c.json({ error: "tag name already exists" }, 409);
    const [row] = await db
      .insert(tags)
      .values({ ...body, userId: c.var.userId })
      .returning();
    return c.json(row, 201);
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await ownedTag(c.var.db, c.var.userId, c.req.valid("param").id);
    if (!row) return c.json(notFound, 404);
    return c.json(row);
  })
  .patch("/:id", zValidator("param", idParam), zValidator("json", tagUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = c.var.db;
    const existing = await ownedTag(db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    if (patch.name !== undefined && patch.name !== existing.name) {
      const [duplicate] = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, c.var.userId), eq(tags.name, patch.name), ne(tags.id, id)));
      if (duplicate) return c.json({ error: "tag name already exists" }, 409);
    }
    if (Object.keys(patch).length === 0) return c.json(existing);
    const [row] = await db.update(tags).set(patch).where(eq(tags.id, id)).returning();
    return c.json(row);
  })
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await ownedTag(c.var.db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    await c.var.db.delete(tags).where(eq(tags.id, id));
    return c.json({ ok: true });
  });
