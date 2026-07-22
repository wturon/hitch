import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "./db/schema.js";
import type { Storage } from "./storage.js";

export type Db = NodePgDatabase<typeof schema>;

// Minimal structural view of the better-auth instance — just what requireAuth
// and the /api/auth/* mount consume. Typed here (instead of as
// ReturnType<typeof createAuth>) so better-auth's types never leak into the
// exported AppType that shared/ compiles against.
export type AuthGateway = {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
  };
};

// Hono env shared by every router: `db`, `auth`, and `storage` are injected
// once in createApp, `userId` is set by the auth middleware (see auth.ts).
export type AppEnv = {
  Variables: {
    db: Db;
    auth: AuthGateway;
    storage: Storage;
    userId: string;
  };
};
