import { Hono } from "hono";

import type { AppEnv, Db } from "./context.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { commentRoutes } from "./routes/comments.js";
import { daemonRoutes } from "./routes/daemon.js";
import { machineRoutes } from "./routes/machines.js";
import { projectRoutes } from "./routes/projects.js";
import { sectionRoutes } from "./routes/sections.js";
import { tagRoutes } from "./routes/tags.js";
import { taskRoutes } from "./routes/tasks.js";

// Routes are chained so the full route tree is captured in `AppType` —
// shared/ feeds this to hono's `hc<AppType>()` typed client. The db is
// injected here (instead of imported by the routers) so tests can point the
// app at a throwaway database.
export function createApp(db: Db) {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("db", db);
      await next();
    })
    .get("/health", (c) => c.json({ ok: true }))
    .route("/projects", projectRoutes)
    .route("/sections", sectionRoutes)
    .route("/tasks", taskRoutes)
    .route("/tags", tagRoutes)
    .route("/comments", commentRoutes)
    .route("/machines", machineRoutes)
    .route("/assignments", assignmentRoutes)
    .route("/daemon", daemonRoutes);
}

export type AppType = ReturnType<typeof createApp>;

// Row types for consumers (shared/ re-exports these).
export type {
  Assignment,
  Attachment,
  Chat,
  Comment,
  Machine,
  Project,
  Section,
  Tag,
  Task,
  TaskTag,
} from "./db/schema.js";
