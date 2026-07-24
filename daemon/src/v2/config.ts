// Hitch daemon config resolution.
//
// The daemon is always server-backed; it resolves BOTH the server URL and the
// api key, from env or from the desktop's stored credentials:
//   - serverUrl: env HITCH_SERVER_URL, else secrets.json `hitchServer.serverUrl`.
//   - apiKey:    env HITCH_API_KEY, else secrets.json `hitchServer.apiKey` (only
//     when its serverUrl matches the resolved URL).
// secrets.json is read from the same App Support dir the rest of the daemon uses
// (HITCH_APP_SUPPORT_DIR / HITCH_CONFIG_PATH / platform default), honoring
// HITCH_SECRETS_PATH just like the desktop. This lets a bare `npm run dev:daemon`
// pick up the URL+key the desktop already minted, with no env at all.
//
// Nothing resolvable is a clear startup error (teaching message), never a silent
// fallthrough.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ServerV2Config {
  serverUrl: string;
  apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Mirrors chatLifecycleStore.ts's appSupportDirFromEnv so the daemon reads the
// SAME dir the desktop wrote secrets.json into.
export function appSupportDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.HITCH_APP_SUPPORT_DIR) return resolve(env.HITCH_APP_SUPPORT_DIR);
  if (env.HITCH_CONFIG_PATH) return dirname(resolve(env.HITCH_CONFIG_PATH));

  if (process.platform === "darwin") {
    const appName = env.HITCH_ROOT ? "Hitch Dev" : "Hitch";
    return join(homedir(), "Library/Application Support", appName);
  }
  return join(homedir(), ".config", "hitch");
}

function secretsPathFromEnv(env: NodeJS.ProcessEnv): string {
  return env.HITCH_SECRETS_PATH ?? join(appSupportDirFromEnv(env), "secrets.json");
}

interface StoredHitchServer {
  serverUrl?: string;
  apiKey?: string;
}

// Reads the `hitchServer` key the desktop persists (see hitchServer.ts /
// main.ts readLocalSecrets). Returns null if the file is missing, unreadable,
// or has no usable hitchServer record.
export function readStoredHitchServer(path: string): StoredHitchServer | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const stored = raw.hitchServer;
  if (!isRecord(stored)) return null;
  return {
    serverUrl: typeof stored.serverUrl === "string" ? stored.serverUrl : undefined,
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey : undefined,
  };
}

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * Resolve the server URL + api key from env or the desktop's stored
 * credentials. Always returns a usable config or throws a teaching error — the
 * daemon is server-backed unconditionally, so there is no null / fallthrough.
 */
export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerV2Config {
  const secretsPath = secretsPathFromEnv(env);
  const stored = readStoredHitchServer(secretsPath);

  // Server URL: env wins, else the stored credentials.
  const rawUrl = env.HITCH_SERVER_URL?.trim() || stored?.serverUrl?.trim();
  if (!rawUrl) {
    throw new Error(
      `[hitch] No Hitch server URL found.\n` +
        `        Sign in via the Hitch desktop app (it writes ${secretsPath}),\n` +
        `        or set HITCH_SERVER_URL=<url> in the environment.`,
    );
  }
  const serverUrl = stripTrailingSlash(rawUrl);

  // 1. Explicit env key wins.
  const envKey = env.HITCH_API_KEY?.trim();
  if (envKey) return { serverUrl, apiKey: envKey };

  // 2. Fallback: the desktop's stored credentials.
  if (stored?.apiKey) {
    // Only trust a stored key that was minted against THIS server (mirrors the
    // desktop's activeCredentials guard) — a stale key for another deployment
    // is not "signed in".
    if (stored.serverUrl && stripTrailingSlash(stored.serverUrl) !== serverUrl) {
      throw new Error(
        `[hitch] HITCH_SERVER_URL is ${serverUrl}, but the stored credentials in\n` +
          `        ${secretsPath} were minted for ${stripTrailingSlash(stored.serverUrl)}.\n` +
          `        Sign in to ${serverUrl} via the desktop app, or set HITCH_API_KEY.`,
      );
    }
    return { serverUrl, apiKey: stored.apiKey };
  }

  throw new Error(
    `[hitch] Found a Hitch server URL (${serverUrl}) but no API key.\n` +
      `        Sign in via the Hitch desktop app (it writes ${secretsPath}),\n` +
      `        or set HITCH_API_KEY=<key> in the environment.`,
  );
}
