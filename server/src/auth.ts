import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { createMiddleware } from "hono/factory";

import type { AppEnv, AuthGateway, Db } from "./context.js";
import * as authSchema from "./db/auth-schema.js";

// Real auth (step 4): better-auth over the app's drizzle db.
// - Desktop signs in with email/password and holds a session cookie.
// - CLI + daemon hold API keys, created by a signed-in session via
//   better-auth's own /api/auth/api-key/* endpoints. The api-key plugin
//   resolves an `x-api-key` header into a mock session, so `getSession`
//   below is the single resolution path for both credential kinds.
// Built per-app (instead of a module singleton) so tests can point it at a
// throwaway database, mirroring how createApp receives its db.
export function createAuth(db: Db) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3010",
    // No email verification — personal tool, self-signup is fine for now.
    emailAndPassword: { enabled: true },
    plugins: [
      apiKey({
        // Lets `getSession` resolve an x-api-key header into a session.
        enableSessionForAPIKeys: true,
        // The plugin's per-key default is 10 requests/day — the daemon's
        // ~30s reconcile tick alone would exhaust that before breakfast.
        rateLimit: { enabled: false },
      }),
    ],
    // TODO(M2): add the Electron client's origin to trustedOrigins once the
    // desktop app talks to this server (OAuth-loopback precedent: port 51789).
  });
}

// Resolves the caller via better-auth — session cookie OR x-api-key header —
// and exposes only `c.var.userId` downstream (handlers never read headers
// themselves). Anything else, including the old x-hitch-user-id placeholder
// header, is a 401.
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  let session;
  try {
    session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  } catch (error) {
    // An invalid/expired api key makes getSession THROW (APIError) rather
    // than return null — either way the caller isn't authenticated.
    if (error instanceof APIError) {
      return c.json({ error: "unauthorized" }, 401);
    }
    throw error;
  }
  if (!session) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", session.user.id);
  await next();
});

// The structural AuthGateway type (see context.ts) is what the rest of the
// app sees; this is the concrete instance type for callers that need it.
export type Auth = ReturnType<typeof createAuth>;
export type { AuthGateway };
