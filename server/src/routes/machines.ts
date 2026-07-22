import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import type { AppEnv } from "../context.js";
import { machines } from "../db/schema.js";

// Client-facing machine routes: read-only. Machines are registered and kept
// alive by the daemon (see daemon.ts); the client only needs the list to pick
// a target when creating an assignment.
export const machineRoutes = new Hono<AppEnv>().use(requireAuth).get("/", async (c) => {
  const rows = await c.var.db
    .select()
    .from(machines)
    .where(eq(machines.userId, c.var.userId))
    .orderBy(machines.name);
  return c.json(rows);
});
