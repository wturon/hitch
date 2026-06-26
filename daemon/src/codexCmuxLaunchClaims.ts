import { createHash } from "node:crypto";
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

interface CodexCmuxLaunchClaim {
  launchId: string;
  cwd: string;
  promptHash: string;
  environment: "cmux";
  createdAt: number;
  workspaceId?: string;
  surfaceId?: string;
  claimedAt?: number;
  chatId?: string;
  ambiguousAt?: number;
  ambiguousMatchCount?: number;
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
  workspaceId?: string | null;
  surfaceId?: string | null;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!input.launchId) return;

  const env = input.env ?? process.env;
  const path = claimsPath(env);
  const now = Date.now();
  const claims = readClaims(path).filter(
    (claim) => now - claim.createdAt <= CLAIM_TTL_MS,
  );
  const index = claims.findIndex((claim) => claim.launchId === input.launchId);
  if (index < 0) return;
  claims[index] = {
    ...claims[index],
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
  };
  writeClaims(path, claims);
}

function claimsPath(env: NodeJS.ProcessEnv): string {
  return join(appSupportDirFromEnv(env), "codex-cmux-launch-claims.json");
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
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
        typeof claim.cwd === "string" &&
        typeof claim.promptHash === "string" &&
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
  cwd?: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!input.launchId) return;

  const env = input.env ?? process.env;
  const path = claimsPath(env);
  const now = Date.now();
  const freshClaims = readClaims(path).filter(
    (claim) => now - claim.createdAt <= CLAIM_TTL_MS,
  );
  const nextClaim: CodexCmuxLaunchClaim = {
    launchId: input.launchId,
    cwd: resolve(input.cwd || process.cwd()),
    promptHash: promptHash(input.prompt),
    environment: "cmux",
    createdAt: now,
  };
  const duplicateIndexes = freshClaims
    .map((claim, index) => ({ claim, index }))
    .filter(({ claim }) => {
      return (
        claim.claimedAt === undefined &&
        claim.environment === nextClaim.environment &&
        claim.cwd === nextClaim.cwd &&
        claim.promptHash === nextClaim.promptHash
      );
    })
    .map(({ index }) => index);
  if (duplicateIndexes.length > 0) {
    const ambiguousAt = now;
    const ambiguousMatchCount = duplicateIndexes.length + 1;
    for (const index of duplicateIndexes) {
      freshClaims[index] = {
        ...freshClaims[index],
        ambiguousAt,
        ambiguousMatchCount,
      };
    }
    nextClaim.ambiguousAt = ambiguousAt;
    nextClaim.ambiguousMatchCount = ambiguousMatchCount;
  }
  freshClaims.push(nextClaim);
  writeClaims(path, freshClaims);
}
