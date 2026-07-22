import { createHitchClient, type HitchClient } from "@hitch/shared";

import { loadConfig, type CliConfig } from "./config.js";
import { CliError } from "./errors.js";

export interface Session {
  client: HitchClient;
  config: CliConfig;
}

export const NOT_LOGGED_IN =
  "Not logged in. Authenticate once with:\n" +
  "  hitch login --server <server-url>\n" +
  "e.g.\n" +
  "  hitch login --server http://localhost:3010";

// Every data command starts here: stored credentials → typed hc client
// (@hitch/shared — the same client the desktop renderer uses), auth rides in
// the x-api-key header.
export function requireSession(): Session {
  const config = loadConfig();
  if (!config) throw new CliError(NOT_LOGGED_IN);
  return {
    config,
    client: createHitchClient(config.serverUrl, { headers: { "x-api-key": config.apiKey } }),
  };
}

/**
 * Turn a non-2xx response into a teaching CliError: 401 → how to re-login;
 * anything else → `context` + the server's own error message. Call it before
 * res.json() on every request.
 */
export async function ensureOk(session: Session, res: Response, context: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) {
    throw new CliError(
      `The stored API key was rejected by ${session.config.serverUrl}. Log in again:\n` +
        `  hitch login --server ${session.config.serverUrl}`,
    );
  }
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") detail = body.error;
    else if (typeof body.message === "string") detail = body.message;
  } catch {
    /* non-JSON error body */
  }
  throw new CliError(`${context} failed (${res.status}${detail ? `: ${detail}` : ""}).`);
}

/**
 * Rewrite Node's bare "fetch failed" into an actionable message. Used by the
 * top-level handler in index.ts (network errors can surface from any command).
 */
export function describeNetworkError(error: unknown): string | null {
  if (!(error instanceof TypeError) || !/fetch failed/i.test(error.message)) return null;
  const cause = (error as { cause?: { code?: string } }).cause;
  const config = loadConfig();
  const target = config ? ` at ${config.serverUrl}` : "";
  return (
    `Could not reach the Hitch server${target}${cause?.code ? ` (${cause.code})` : ""}.\n` +
    `Check that the server is running, or point the CLI elsewhere with:\n` +
    `  hitch login --server <server-url>`
  );
}
