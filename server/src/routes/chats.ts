import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ne, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { chats, machines } from "../db/schema.js";
import { chatClientListQuery } from "../validation.js";

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
    const conds: SQL[] = [eq(machines.userId, c.var.userId)];
    if (q.machine_id) conds.push(eq(chats.machineId, q.machine_id));
    // "Live" is the negative of the one terminal status: a dead chat is one the
    // machine stopped seeing. dormant/idle chats are still live — they're
    // resumable, and hiding them is what a session browser does, not a monitor.
    if (q.live === "true") conds.push(ne(chats.status, "dead"));
    const rows = await c.var.db
      .select({ chat: chats })
      .from(chats)
      .innerJoin(machines, eq(chats.machineId, machines.id))
      .where(and(...conds))
      .orderBy(desc(chats.lastActivityAt));
    return c.json(rows.map((r) => r.chat));
  });
