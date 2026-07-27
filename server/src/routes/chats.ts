import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { assignments, chatEvents, chats, machines, projects, tasks } from "../db/schema.js";
import { chatClientListQuery, chatEventListQuery, idParam } from "../validation.js";
import { chatIsVisible } from "./chatPredicates.js";
import { notFound, ownedChat } from "./helpers.js";

// Client-facing chat routes: read-only. Chats are created and observed by the
// daemon (see daemon.ts) — the client renders them and, for the Chat
// Inspector, reads the axes behind the derived status.
//
// Ownership has no user_id shortcut: chats scope through their machine, which
// is exactly what `ownedChat` does for a single row (routes/helpers.ts). The
// list mirrors assignments.ts and does the join inline.
export const chatRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", zValidator("query", chatClientListQuery), async (c) => {
    const q = c.req.valid("query");
    const db = c.var.db;
    const conds: SQL[] = [eq(machines.userId, c.var.userId)];
    if (q.machine_id) conds.push(eq(chats.machineId, q.machine_id));
    // "Live" is the negative of the one terminal status: a dead chat is one the
    // machine stopped seeing. dormant/idle chats are still live — they're
    // resumable, and hiding them is what a session browser does, not a monitor.
    if (q.live === "true") conds.push(chatIsVisible);
    const rows = await db
      .select({
        chat: chats,
        // Denormalised for the reader: a chat row carries ids, and every
        // surface that renders one immediately needs the two names behind
        // them. Both joins are 1:1 (or absent), so neither multiplies rows.
        machineName: machines.name,
        projectName: projects.name,
      })
      .from(chats)
      .innerJoin(machines, eq(chats.machineId, machines.id))
      .leftJoin(projects, eq(chats.projectId, projects.id))
      .where(and(...conds))
      .orderBy(desc(chats.lastActivityAt));

    // Attachment 1 — the task this chat serves. It hangs off assignments
    // (assignments.chat_id), NOT off the chat, so it can't ride the query
    // above without risking row multiplication when a chat has been assigned
    // more than once. One extra round trip, keyed on the ids we just read.
    const chatIds = rows.map((r) => r.chat.id);
    const taskByChatId = new Map<string, { id: string; title: string; assignmentId: string }>();
    if (chatIds.length > 0) {
      const attached = await db
        .select({
          chatId: assignments.chatId,
          assignmentId: assignments.id,
          taskId: tasks.id,
          taskTitle: tasks.title,
          createdAt: assignments.createdAt,
        })
        .from(assignments)
        .innerJoin(tasks, eq(assignments.taskId, tasks.id))
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(and(eq(projects.userId, c.var.userId), inArray(assignments.chatId, chatIds)))
        .orderBy(assignments.createdAt);
      // Ascending order + overwrite = the LATEST assignment wins, matching how
      // the delegate bar reads an append-only assignment history.
      for (const row of attached) {
        if (!row.chatId) continue;
        taskByChatId.set(row.chatId, {
          id: row.taskId,
          title: row.taskTitle,
          assignmentId: row.assignmentId,
        });
      }
    }

    return c.json(
      rows.map((r) => ({
        ...r.chat,
        machineName: r.machineName,
        projectName: r.projectName,
        task: taskByChatId.get(r.chat.id) ?? null,
      })),
    );
  })
  // The relayed hook-event tail for ONE chat — the "why" behind its state
  // (docs/chat-tracking-redesign.md §9, the Inspector's row drawer). Per-chat
  // and lazy on purpose: this is a debugging read, and the list above must not
  // pay for it. Newest first, bounded.
  .get(
    "/:id/events",
    zValidator("param", idParam),
    zValidator("query", chatEventListQuery),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      const chat = await ownedChat(c.var.db, c.var.userId, id);
      if (!chat) return c.json(notFound, 404);
      const rows = await c.var.db
        .select()
        .from(chatEvents)
        .where(eq(chatEvents.chatId, id))
        .orderBy(desc(chatEvents.at))
        .limit(limit);
      return c.json(rows);
    },
  );
