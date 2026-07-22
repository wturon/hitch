import { hc } from "hono/client";
import type { ClientRequestOptions } from "hono/client";

import type { AppType } from "@hitch/server";

export const HITCH_API_VERSION = 1;

// The full route tree type — hc<AppType> gives end-to-end typed requests.
export type { AppType } from "@hitch/server";

// Row types (drizzle $inferSelect, re-exported through @hitch/server).
// Note: over the wire, Date fields arrive as ISO strings (JSON).
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
} from "@hitch/server";

// Explicit alias so the declaration emit doesn't have to name hono internals.
export type HitchClient = ReturnType<typeof hc<AppType>>;

// With the step-3 placeholder auth, pass the user via
// `opts.headers["x-hitch-user-id"]`; step 4 (better-auth) swaps that for a
// session cookie / api key without changing this signature.
export function createHitchClient(baseUrl: string, opts?: ClientRequestOptions): HitchClient {
  return hc<AppType>(baseUrl, opts);
}
