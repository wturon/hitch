import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "./db/schema.js";

export type Db = NodePgDatabase<typeof schema>;

// Hono env shared by every router: `db` is injected once in createApp,
// `userId` is set by the auth middleware (see auth.ts).
export type AppEnv = {
  Variables: {
    db: Db;
    userId: string;
  };
};
