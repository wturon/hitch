import { Hono } from "hono";
import { cors } from "hono/cors";

import { createAuth } from "./auth.js";
import type { AppEnv, AuthGateway, Db } from "./context.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { commentRoutes } from "./routes/comments.js";
import { daemonRoutes } from "./routes/daemon.js";
import { machineRoutes } from "./routes/machines.js";
import { projectRoutes } from "./routes/projects.js";
import { sectionRoutes } from "./routes/sections.js";
import { tagRoutes } from "./routes/tags.js";
import { taskRoutes } from "./routes/tasks.js";
import { createStorage, storageConfigFromEnv } from "./storage.js";
import type { Storage } from "./storage.js";

// Routes are chained so the full route tree is captured in `AppType` —
// shared/ feeds this to hono's `hc<AppType>()` typed client. The db and
// blob storage are injected here (instead of imported by the routers) so
// tests can point the app at a throwaway database + Garage container.
export function createApp(db: Db, storage: Storage = createStorage(storageConfigFromEnv())) {
  // Structural cast: better-auth's getSession takes a superset of the
  // AuthGateway input and returns a superset of its output, but its generic
  // signature isn't directly assignable — see AuthGateway in context.ts.
  const auth = createAuth(db) as unknown as AuthGateway;
  return new Hono<AppEnv>()
    // Wildcard CORS is legal here because auth rides in a header (x-api-key),
    // never cookies/credentials — so no credentialed-CORS restrictions apply.
    // Mounted first so it covers every route, /api/auth/* included. Callers:
    // renderer dev server (http://127.0.0.1:5173) and the packaged app's
    // file:// null origin, both of which only "*" satisfies.
    .use(cors({ origin: "*", allowHeaders: ["Content-Type", "x-api-key"] }))
    .use(async (c, next) => {
      c.set("db", db);
      c.set("auth", auth);
      c.set("storage", storage);
      await next();
    })
    .get("/health", (c) => c.json({ ok: true }))
    // better-auth owns everything under /api/auth/* (sign-up/sign-in/sign-out,
    // session, api-key CRUD). Mounted before the requireAuth-protected routers.
    .on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw))
    .route("/projects", projectRoutes)
    .route("/sections", sectionRoutes)
    .route("/tasks", taskRoutes)
    .route("/tags", tagRoutes)
    .route("/comments", commentRoutes)
    .route("/attachments", attachmentRoutes)
    .route("/machines", machineRoutes)
    .route("/assignments", assignmentRoutes)
    .route("/daemon", daemonRoutes);
}

export type AppType = ReturnType<typeof createApp>;

// WS wire-protocol types for consumers (shared/ re-exports these). The /ws
// endpoint itself is mounted by attachWebSocket in ws.ts, outside AppType.
export type {
  WsClientEventMessage,
  WsClientMessage,
  WsEventMessage,
  WsHelloMessage,
  WsInvalidateMessage,
  WsServerMessage,
} from "./ws.js";

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
