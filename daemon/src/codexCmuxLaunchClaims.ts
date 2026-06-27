import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CLAIM_TTL_MS = 10 * 60 * 1000;

// Correlates a Codex launch (which has no --session-id to pin up front) to the
// thread the hook later discovers. The daemon records the claim at launch, then
// stamps the cmux surface id onto it just before sending the command (so it's on
// disk before Codex can emit a hook event); the hook joins on that surface id
// (CMUX_SURFACE_ID) when Codex first reports its thread. Surface ids are unique
// per pane, so the join is unambiguous — no prompt/cwd fingerprint, no race.
interface CodexCmuxLaunchClaim {
  launchId: string;
  environment: "cmux";
  createdAt: number;
  surfaceId?: string;
  claimedAt?: number;
  chatId?: string;
}

function appSupportDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.HITCH_APP_SUPPORT_DIR) return resolve(env.HITCH_APP_SUPPORT_DIR);
  if (env.HITCH_CONFIG_PATH) return dirname(resolve(env.HITCH_CONFIG_PATH));

  if (process.platform === "darwin") {
    const appName = env.HITCH_ROOT ? "Hitch Dev" : "Hitch";
    return join(homedir(), "Library/Application Support", appName);
  }
  return join(homedir(), ".config", "hitch");
}

export function updateCodexCmuxLaunchClaim(input: {
  launchId?: string;
  surfaceId?: string | null;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!input.launchId || !input.surfaceId) return;

  const env = input.env ?? process.env;
  const path = claimsPath(env);
  const now = Date.now();
  const claims = readClaims(path).filter(
    (claim) => now - claim.createdAt <= CLAIM_TTL_MS,
  );
  const index = claims.findIndex((claim) => claim.launchId === input.launchId);
  if (index < 0) return;
  claims[index] = { ...claims[index], surfaceId: input.surfaceId };
  writeClaims(path, claims);
}

function claimsPath(env: NodeJS.ProcessEnv): string {
  return join(appSupportDirFromEnv(env), "codex-cmux-launch-claims.json");
}

function readClaims(path: string): CodexCmuxLaunchClaim[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((claim): claim is CodexCmuxLaunchClaim => {
      return (
        typeof claim === "object" &&
        claim !== null &&
        typeof claim.launchId === "string" &&
        claim.environment === "cmux" &&
        typeof claim.createdAt === "number"
      );
    });
  } catch {
    return [];
  }
}

function writeClaims(path: string, claims: CodexCmuxLaunchClaim[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

export function recordCodexCmuxLaunchClaim(input: {
  launchId?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!input.launchId) return;

  const env = input.env ?? process.env;
  const path = claimsPath(env);
  const now = Date.now();
  const freshClaims = readClaims(path).filter(
    (claim) => now - claim.createdAt <= CLAIM_TTL_MS,
  );
  freshClaims.push({
    launchId: input.launchId,
    environment: "cmux",
    createdAt: now,
  });
  writeClaims(path, freshClaims);
}
