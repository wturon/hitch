// THROWAWAY (deleted at M5). Writes an ImportPlan straight into Postgres with
// Drizzle — no HTTP, no auth, no NOTIFY consumers assumed. MUST only run
// against a fresh/quiet database (the M5 cutover DB or a scratch container):
// it bypasses the API layer entirely and its only idempotency protection is
// the refuse-if-user-has-tasks guard below.

import { count, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { generateNKeysBetween } from "fractional-indexing";

import * as schema from "../db/schema.js";
import type { ImportPlan } from "./plan.js";

type Db = NodePgDatabase<typeof schema>;

export interface ExecuteResult {
  userId: string;
  projects: number;
  tasks: number;
  tags: number;
  taskTags: number;
}

export interface ExecuteOptions {
  // Bypass the refuse-if-user-has-tasks guard so a second pass can add more
  // projects on top of the first (e.g. Hitch from --from-dir after the export
  // pass). The existing counts are still surfaced loudly. Without it the guard
  // stays: the importer assumes a fresh DB.
  allowExisting?: boolean;
}

export async function executePlan(
  db: Db,
  plan: ImportPlan,
  userEmail: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const [user] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, userEmail));
  if (!user) {
    throw new Error(
      `no better-auth user with email ${userEmail} — sign the user up first, then re-run`,
    );
  }

  // Idempotency guard (simple, throwaway): refuse when the target user already
  // has any tasks. Delete their projects (tasks cascade) to re-run — or pass
  // --allow-existing to append (the two-pass import needs pass 2 to run).
  const userProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.userId, user.id));
  if (userProjects.length > 0) {
    const [{ value: existingTasks }] = await db
      .select({ value: count() })
      .from(schema.tasks)
      .where(
        inArray(
          schema.tasks.projectId,
          userProjects.map((p) => p.id),
        ),
      );
    if (existingTasks > 0) {
      if (!opts.allowExisting) {
        throw new Error(
          `refusing to import: user ${userEmail} already has ${existingTasks} task(s) — ` +
            `this importer only targets a fresh DB (pass --allow-existing to append)`,
        );
      }
      console.warn(
        `\n⚠️  --allow-existing: user ${userEmail} already has ` +
          `${userProjects.length} project(s) / ${existingTasks} task(s). ` +
          `Guard BYPASSED — appending this plan on top of them.\n`,
      );
    }
  }

  const result: ExecuteResult = {
    userId: user.id,
    projects: 0,
    tasks: 0,
    tags: 0,
    taskTags: 0,
  };

  await db.transaction(async (tx) => {
    // User-level tag registry first, so task links can resolve ids.
    const tagIds = new Map<string, string>();
    for (const [name, color] of plan.tagColors) {
      const [row] = await tx
        .insert(schema.tags)
        .values({ userId: user.id, name, color })
        .returning({ id: schema.tags.id });
      tagIds.set(name, row.id);
      result.tags++;
    }

    const projectKeys = generateNKeysBetween(null, null, plan.projects.length);
    for (const [pi, project] of plan.projects.entries()) {
      const [projectRow] = await tx
        .insert(schema.projects)
        .values({ userId: user.id, name: project.name, sortOrder: projectKeys[pi] })
        .returning({ id: schema.projects.id });
      result.projects++;

      // V1 has no sections → none created; every task sits at project root in
      // its preserved order.
      const taskKeys = generateNKeysBetween(null, null, project.tasks.length);
      for (const [ti, task] of project.tasks.entries()) {
        const [taskRow] = await tx
          .insert(schema.tasks)
          .values({
            projectId: projectRow.id,
            sectionId: null,
            title: task.title,
            body: task.body, // VERBATIM
            status: task.status,
            sortOrder: taskKeys[ti],
            completedAt: task.completedAtMs === null ? null : new Date(task.completedAtMs),
          })
          .returning({ id: schema.tasks.id });
        result.tasks++;

        for (const tag of task.tags) {
          const tagId = tagIds.get(tag);
          if (!tagId) continue; // can't happen: plan registers every seen tag
          await tx.insert(schema.taskTags).values({ taskId: taskRow.id, tagId });
          result.taskTags++;
        }
      }
    }
  });

  return result;
}
