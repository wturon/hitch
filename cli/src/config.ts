import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stored credentials — the same trio the desktop keeps (hitchServer.ts):
// the server this key was minted against, the key itself, and the key's row
// id so logout can revoke it server-side.
export interface CliConfig {
  serverUrl: string;
  apiKey: string;
  /** better-auth api-key row id — needed to delete the key on logout. */
  apiKeyId?: string;
}

// ~/.config/hitch/cli.json, honoring XDG_CONFIG_HOME. `env` is injectable so
// tests can point this at a scratch dir without touching the real config.
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hitch", "cli.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath(env), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    if (typeof parsed.serverUrl !== "string" || typeof parsed.apiKey !== "string") return null;
    return {
      serverUrl: parsed.serverUrl,
      apiKey: parsed.apiKey,
      apiKeyId: typeof parsed.apiKeyId === "string" ? parsed.apiKeyId : undefined,
    };
  } catch {
    // A corrupt file counts as "not logged in" — login rewrites it whole.
    return null;
  }
}

export function saveConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env): void {
  const file = configPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  // 0600: the file holds a live API key.
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function deleteConfig(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(configPath(env), { force: true });
}
