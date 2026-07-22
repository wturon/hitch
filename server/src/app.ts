import { Hono } from "hono";

// Routes are chained so the full route tree is captured in `AppType` —
// later steps feed this to hono's `hc<AppType>()` typed client in shared/.
export const app = new Hono().get("/health", (c) => c.json({ ok: true }));

export type AppType = typeof app;
