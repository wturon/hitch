// Hitch V2 daemon config resolution.
//
// The daemon runs in V2 mode iff HITCH_SERVER_URL is set (the same gate the
// desktop main process uses — see desktop/src/main/hitchServer.ts). V1 (Convex)
// stays the default and is untouched.
//
// Credential precedence:
//   1. env HITCH_SERVER_URL (+ HITCH_API_KEY) — the scripted/e2e path.
//   2. fallback: the desktop's secrets.json `hitchServer` key (minted by the
//      desktop's sign-in flow) in the same App Support dir the rest of the
//      daemon already resolves (HITCH_APP_SUPPORT_DIR / HITCH_CONFIG_PATH /
//      platform default), honoring HITCH_SECRETS_PATH just like the desktop.
//
// A URL with no resolvable key is a clear startup error, never a silent V1
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
 * Whether this launch should run the V2 daemon at all — a pure env check so the
 * index.ts/runner.ts seam can branch before touching any V2 code.
 */
export function isServerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HITCH_SERVER_URL?.trim());
}

/**
 * Resolve the V2 server URL + api key. Returns null when NOT in server mode
 * (no HITCH_SERVER_URL) so callers can fall through to V1. Throws a teaching
 * error when the URL is set but no key can be resolved.
 */
export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerV2Config | null {
  const rawUrl = env.HITCH_SERVER_URL?.trim();
  if (!rawUrl) return null;
  const serverUrl = stripTrailingSlash(rawUrl);

  // 1. Explicit env key wins.
  const envKey = env.HITCH_API_KEY?.trim();
  if (envKey) return { serverUrl, apiKey: envKey };

  // 2. Fallback: the desktop's stored credentials.
  const secretsPath = secretsPathFromEnv(env);
  const stored = readStoredHitchServer(secretsPath);
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
    `[hitch] HITCH_SERVER_URL is set (${serverUrl}) but no API key was found.\n` +
      `        Sign in via the Hitch desktop app (it writes ${secretsPath}),\n` +
      `        or set HITCH_API_KEY=<key> in the environment.`,
  );
}
