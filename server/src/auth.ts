import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./context.js";

// PLACEHOLDER AUTH — step 4 (better-auth) swaps this for a real requireAuth
// (session cookie for the desktop, api-key for CLI + daemon). The contract
// stays the same: downstream handlers read `c.var.userId` and never look at
// headers themselves, so only this file changes in step 4.
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.req.header("x-hitch-user-id");
  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", userId);
  await next();
});
