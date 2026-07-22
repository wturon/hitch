import { createHitchClient, type HitchClient } from "@hitch/shared";

export type { HitchClient };

// All renderer HTTP rides the typed hc client with the API key minted by the
// main process — no cookies, no Authorization header, just x-api-key (which
// keeps the server's wildcard CORS legal).
export function createServerClient(serverUrl: string, apiKey: string): HitchClient {
  return createHitchClient(serverUrl, { headers: { "x-api-key": apiKey } });
}
