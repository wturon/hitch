import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { assignments, projects, tasks } from "../db/schema.js";
import { DEFAULT_PROMPT_TEMPLATE, resolvePromptTemplate } from "../prompt.js";
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
    // Resolve the template ONCE, here, against the task as it stands right now.
    // assignments.prompt is a record of what was sent, so later edits to the
    // task never rewrite the prompt an agent was actually given.
    //
    // Blank (not just absent) counts as "nothing was chosen" on BOTH fields —
    // `??` alone would store "" and launch an agent with no instructions.
    const { promptTemplate, prompt: legacyPrompt, ...rest } = body;
    const template = promptTemplate?.trim() ? promptTemplate : null;
    const legacy = legacyPrompt?.trim() ? legacyPrompt : null;
    // A legacy prompt is used VERBATIM, never resolved. Old clients composed
    // the final text themselves — inlining the task body into it — so resolving
    // it again would expand any variable name the BODY happens to mention,
    // duplicating the task inside its own prompt. (Tasks about this feature are
    // exactly the ones whose bodies say "$TASK_BODY".)
    const taskValues = { id: task.id, title: task.title, body: task.body };
    const resolved =
      legacy && !template
        ? legacy
        : resolvePromptTemplate(template ?? DEFAULT_PROMPT_TEMPLATE, taskValues);
    // A non-blank template can still RESOLVE to blank — `$TASK_TITLE` alone,
    // against a whitespace title (titles are min(1), not min(1) non-blank).
    // Checking the output rather than the input is what actually keeps the
    // never-store-an-empty-prompt promise the daemon relies on.
    const prompt = resolved.trim()
      ? resolved
      : resolvePromptTemplate(DEFAULT_PROMPT_TEMPLATE, taskValues);
    const [row] = await db.insert(assignments).values({ ...rest, prompt }).returning();
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
