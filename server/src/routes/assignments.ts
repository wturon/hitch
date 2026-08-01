import { zValidator } from "@hono/zod-validator";
import {
  and,
  eq,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { assignments, chats, machines, projects, tasks } from "../db/schema.js";
import { DEFAULT_PROMPT_TEMPLATE, resolvePromptTemplate } from "../prompt.js";
import {
  assignmentClientUpdate,
  assignmentCreate,
  assignmentLink,
  assignmentListQuery,
  idParam,
} from "../validation.js";
import { chatIsAttachable } from "./chatPredicates.js";
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
  .post("/link", zValidator("json", assignmentLink), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const task = await ownedTask(db, c.var.userId, body.taskId);
    if (!task) return c.json(notFound, 404);

    // Session ids are harness-native and only machine-local in the schema.
    // Usually this is one row; reject ambiguity instead of guessing which
    // machine the CLI is running on. A caller that already knows the machine
    // (the desktop picker, which selects a whole chat row) narrows to it, which
    // makes the ambiguity 409 below unreachable for that path. Ownership is
    // still enforced by the user join — machineId narrows, it never widens.
    const candidates = await db
      .select({ chat: chats })
      .from(chats)
      .innerJoin(machines, eq(chats.machineId, machines.id))
      .where(
        and(
          eq(machines.userId, c.var.userId),
          eq(chats.harness, body.harness),
          eq(chats.sessionId, body.sessionId),
          ...(body.machineId ? [eq(chats.machineId, body.machineId)] : []),
          chatIsAttachable,
        ),
      );
    if (candidates.length === 0) {
      return c.json(
        {
          error:
            "current live chat was not found in Hitch; check Chat Inspector health and try again",
        },
        404,
      );
    }
    if (candidates.length > 1) {
      return c.json(
        { error: "current chat is ambiguous across machines; open it from Hitch and try again" },
        409,
      );
    }
    const chat = candidates[0].chat;

    const result = await db.transaction(async (tx) => {
      // Two simultaneous link commands must collapse to one assignment. Chat
      // lock ALWAYS precedes task lock; that invariant prevents deadlocks
      // across competing task/chat pairings and server processes.
      for (const key of [`chat:${chat.id}`, `task:${task.id}`]) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      }

      // A task may have any number of live assignments at once — several chats
      // working the same task is the point — so there is no task-side guard.
      // The CHAT side stays exclusive: a chat serves one task at a time,
      // because stopping an assignment closes its chat, so "moving" a chat
      // would need a release-without-closing lifecycle we deliberately don't
      // have. Everything below therefore keys off this chat's live work.
      const terminalStates: Array<"done" | "dead"> = ["done", "dead"];
      const activeForChat = await tx
        .select()
        .from(assignments)
        .where(
          and(
            or(eq(assignments.chatId, chat.id), eq(assignments.requestedChatId, chat.id)),
            notInArray(assignments.observedState, terminalStates),
          ),
        );

      // Same chat, same task, still wanted running: a retry (or the loser of
      // the advisory-lock race) gets the row it already has, never a duplicate.
      const samePair = activeForChat.find(
        (row) => row.taskId === task.id && row.desiredState === "running",
      );
      if (samePair) return { kind: "existing" as const, row: samePair };

      // A chat can hold both a stopping row on THIS task and a live row on
      // another; the query has no order, so prefer the same-task row
      // explicitly. Both are legitimate 409s, but "your stop is still in
      // flight" is the more specific, more actionable of the two.
      const conflict = activeForChat.find((row) => row.taskId === task.id) ?? activeForChat[0];
      if (conflict) {
        if (conflict.taskId === task.id) {
          // Only reachable while a stop is in flight for this very pair.
          // Inserting would hand back an assignment the daemon is about to kill
          // along with the chat it is closing.
          return {
            kind: "conflict" as const,
            error:
              "This chat's assignment on this task is being stopped. Wait for that to finish, " +
              "or start a new chat for this task.",
          };
        }
        const [other] = await tx
          .select({ title: tasks.title })
          .from(tasks)
          .where(eq(tasks.id, conflict.taskId))
          .limit(1);
        // Naming the other task is the useful part, but an unreadable or blank
        // title must degrade to the generic sentence, never to a 500.
        const otherTitle = (other?.title ?? "").trim();
        return {
          kind: "conflict" as const,
          error:
            `This chat is already working on another task${otherTitle ? `: "${otherTitle}"` : ""}. ` +
            "A chat belongs to one task at a time — finish or stop that one first, or start a " +
            "new chat for this task.",
        };
      }

      const [row] = await tx
        .insert(assignments)
        .values({
          taskId: task.id,
          machineId: chat.machineId,
          harness: chat.harness,
          // Nothing is sent when adopting an already-running chat. Null is the
          // honest audit value and also guarantees a lost request can never
          // degrade into spawning a new agent.
          prompt: null,
          requestedChatId: chat.id,
          desiredState: "running",
        })
        .returning();
      return { kind: "created" as const, row };
    });
    if (result.kind === "conflict") return c.json({ error: result.error }, 409);
    return c.json(result.row, result.kind === "existing" ? 200 : 201);
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
