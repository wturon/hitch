// Typed Hono client for the V2 server — the same hc<AppType> the desktop
// renderer and CLI use (@hitch/shared). The daemon authenticates with an api
// key in the x-api-key header (better-auth's api-key plugin resolves it into a
// session; see server/src/auth.ts).

import { createHitchClient, type HitchClient } from "@hitch/shared";

export type { HitchClient } from "@hitch/shared";

export function createServerClient(serverUrl: string, apiKey: string): HitchClient {
  return createHitchClient(serverUrl, { headers: { "x-api-key": apiKey } });
}
