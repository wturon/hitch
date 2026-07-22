import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { assignments, chats, machines } from "../db/schema.js";
import {
  assignmentObservationUpdate,
  chatCreate,
  chatListQuery,
  chatUpdate,
  idParam,
  machineHeartbeat,
  machineRegister,
} from "../validation.js";
import { notFound, ownedAssignment, ownedChat, ownedMachine, ownedProject } from "./helpers.js";

// Daemon-facing routes (mounted at /daemon). The daemon authenticates with an
// api key (x-api-key → requireAuth, see auth.ts), and the ownership rule is
// enforced here: chats are daemon-created (single-creator-per-table), and the
// assignment PATCH below is the exact mirror image of the client one
// (observations only, never intent).
export const daemonRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  // Register/upsert-by-name: the daemon calls this on startup; a machine name
  // is stable per host ("wills-mbp"), so re-registering updates in place.
  .post("/machines", zValidator("json", machineRegister), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const [existing] = await db
      .select()
      .from(machines)
      .where(and(eq(machines.userId, c.var.userId), eq(machines.name, body.name)));
    if (existing) {
      const [row] = await db
        .update(machines)
        .set({ daemonVersion: body.daemonVersion, lastSeenAt: new Date() })
        .where(eq(machines.id, existing.id))
        .returning();
      return c.json(row);
    }
    const [row] = await db
      .insert(machines)
      .values({ ...body, userId: c.var.userId })
      .returning();
    return c.json(row, 201);
  })
  .patch(
    "/machines/:id/heartbeat",
    zValidator("param", idParam),
    zValidator("json", machineHeartbeat),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const existing = await ownedMachine(c.var.db, c.var.userId, id);
      if (!existing) return c.json(notFound, 404);
      const [row] = await c.var.db
        .update(machines)
        .set({
          lastSeenAt: new Date(),
          ...(patch.daemonVersion !== undefined ? { daemonVersion: patch.daemonVersion } : {}),
        })
        .where(eq(machines.id, id))
        .returning();
      return c.json(row);
    },
  )
  .get("/chats", zValidator("query", chatListQuery), async (c) => {
    const { machine_id: machineId } = c.req.valid("query");
    const machine = await ownedMachine(c.var.db, c.var.userId, machineId);
    if (!machine) return c.json(notFound, 404);
    const rows = await c.var.db
      .select()
      .from(chats)
      .where(eq(chats.machineId, machineId))
      .orderBy(chats.lastActivityAt);
    return c.json(rows);
  })
  .post("/chats", zValidator("json", chatCreate), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const machine = await ownedMachine(db, c.var.userId, body.machineId);
    if (!machine) return c.json(notFound, 404);
    if (body.projectId != null) {
      const project = await ownedProject(db, c.var.userId, body.projectId);
      if (!project) return c.json(notFound, 404);
    }
    const [row] = await db.insert(chats).values(body).returning();
    return c.json(row, 201);
  })
  .patch("/chats/:id", zValidator("param", idParam), zValidator("json", chatUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = c.var.db;
    const existing = await ownedChat(db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    if (patch.machineId !== undefined) {
      const machine = await ownedMachine(db, c.var.userId, patch.machineId);
      if (!machine) return c.json(notFound, 404);
    }
    if (patch.projectId != null) {
      const project = await ownedProject(db, c.var.userId, patch.projectId);
      if (!project) return c.json(notFound, 404);
    }
    if (Object.keys(patch).length === 0) return c.json(existing);
    const [row] = await db.update(chats).set(patch).where(eq(chats.id, id)).returning();
    return c.json(row);
  })
  // Observation PATCH — DAEMON-writable fields ONLY (observed_state, chat_id,
  // worktree). desired_state/reviewed_at stay client-only; strictObject in
  // the schema rejects them with a 400.
  .patch(
    "/assignments/:id",
    zValidator("param", idParam),
    zValidator("json", assignmentObservationUpdate),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const db = c.var.db;
      const existing = await ownedAssignment(db, c.var.userId, id);
      if (!existing) return c.json(notFound, 404);
      if (patch.chatId != null) {
        const chat = await ownedChat(db, c.var.userId, patch.chatId);
        if (!chat) return c.json(notFound, 404);
      }
      const updates: Partial<typeof assignments.$inferInsert> = {};
      if (patch.observedState !== undefined) updates.observedState = patch.observedState;
      if (patch.chatId !== undefined) updates.chatId = patch.chatId;
      if (patch.worktree !== undefined) updates.worktree = patch.worktree;
      if (Object.keys(updates).length === 0) return c.json(existing);
      const [row] = await db
        .update(assignments)
        .set(updates)
        .where(eq(assignments.id, id))
        .returning();
      return c.json(row);
    },
  );
