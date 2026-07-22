import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { assignments, projects, tasks } from "../db/schema.js";
import { assignmentClientUpdate, assignmentCreate, assignmentListQuery, idParam } from "../validation.js";
import { notFound, ownedAssignment, ownedMachine, ownedTask } from "./helpers.js";

// Client-facing assignment routes. Assignments are append-only intent rows
// (single-creator-per-table rule): the client creates them and may only touch
// desired_state + reviewed_at. Observations (observed_state, chat_id,
// worktree) flow exclusively through the daemon routes — see daemon.ts.
export const assignmentRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", zValidator("query", assignmentListQuery), async (c) => {
    const q = c.req.valid("query");
    const conds: (SQL | undefined)[] = [eq(projects.userId, c.var.userId)];
    if (q.task_id) conds.push(eq(assignments.taskId, q.task_id));
    if (q.attention === "true") {
      // The PRD attention queue: needs input, or finished but not yet acked.
      conds.push(
        or(
          eq(assignments.observedState, "waiting_input"),
          and(eq(assignments.observedState, "done"), isNull(assignments.reviewedAt)),
        ),
      );
    }
    const rows = await c.var.db
      .select({ assignment: assignments })
      .from(assignments)
      .innerJoin(tasks, eq(assignments.taskId, tasks.id))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(...conds))
      .orderBy(assignments.createdAt);
    return c.json(rows.map((r) => r.assignment));
  })
  .post("/", zValidator("json", assignmentCreate), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const task = await ownedTask(db, c.var.userId, body.taskId);
    if (!task) return c.json(notFound, 404);
    const machine = await ownedMachine(db, c.var.userId, body.machineId);
    if (!machine) return c.json(notFound, 404);
    const [row] = await db.insert(assignments).values(body).returning();
    return c.json(row, 201);
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await ownedAssignment(c.var.db, c.var.userId, c.req.valid("param").id);
    if (!row) return c.json(notFound, 404);
    return c.json(row);
  })
  .patch(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", assignmentClientUpdate),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const existing = await ownedAssignment(c.var.db, c.var.userId, id);
      if (!existing) return c.json(notFound, 404);
      const updates: Partial<typeof assignments.$inferInsert> = {};
      if (patch.desiredState !== undefined) updates.desiredState = patch.desiredState;
      if (patch.reviewedAt !== undefined) updates.reviewedAt = patch.reviewedAt;
      if (Object.keys(updates).length === 0) return c.json(existing);
      const [row] = await c.var.db
        .update(assignments)
        .set(updates)
        .where(eq(assignments.id, id))
        .returning();
      return c.json(row);
    },
  );
