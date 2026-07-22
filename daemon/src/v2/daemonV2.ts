// Hitch V2 daemon entrypoint (PR 1 — foundation only).
//
// This is the mirror-and-bypass of startHitchDaemon: in V2 mode the daemon
// talks to the Hono server, never Convex, and (for now) does three things —
// register this machine, heartbeat it, and hold a WS connection. The observer,
// reconciler, and launchers land in later M4 PRs; this PR proves the transport
// and lifecycle.
//
// Single-creator rule (PRD): the daemon registers/heartbeats its OWN machine
// row (idempotent upsert-by-name on the server) and never persists the returned
// id locally — re-registration on every boot is the source of truth.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { resolveServerConfig } from "./config.js";
import { createServerClient } from "./serverClient.js";
import { startServerWs, type ServerWsClient } from "./ws.js";

export interface HitchDaemonV2Logger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface HitchDaemonV2Options {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envFiles?: string[];
  logger?: HitchDaemonV2Logger;
}

export interface HitchDaemonV2Handle {
  machineId: string;
  stop: () => Promise<void>;
}

const defaultLogger: HitchDaemonV2Logger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

// 30s heartbeat by default (PRD reconcile cadence). Overridable so the
// integration test can watch last_seen_at advance without waiting.
const DEFAULT_HEARTBEAT_MS = 30_000;

function loadEnvFiles(cwd: string, envFiles: string[], env: NodeJS.ProcessEnv): void {
  for (const file of envFiles) {
    dotenv.config({ path: resolve(cwd, file), processEnv: env as Record<string, string> });
  }
}

function readDaemonVersion(): string {
  // src/v2/daemonV2.ts (tsx) and dist/v2/daemonV2.js (packaged) both sit two
  // dirs below daemon/package.json.
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function heartbeatMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HITCH_HEARTBEAT_MS?.trim();
  if (!raw) return DEFAULT_HEARTBEAT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_MS;
}

export async function startHitchDaemonV2(
  options: HitchDaemonV2Options = {},
): Promise<HitchDaemonV2Handle> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  loadEnvFiles(cwd, options.envFiles ?? [".env.local", ".env"], env);

  const config = resolveServerConfig(env);
  if (!config) {
    // Unreachable via the index.ts/runner.ts seam (it only calls us when
    // HITCH_SERVER_URL is set), but explicit beats a confusing null deref.
    throw new Error("[hitch] startHitchDaemonV2 called without HITCH_SERVER_URL set.");
  }

  const version = readDaemonVersion();
  const name = hostname();
  const client = createServerClient(config.serverUrl, config.apiKey);

  // --- Register this machine (idempotent upsert-by-name) --------------------
  const registerRes = await client.daemon.machines.$post({
    json: { name, daemonVersion: version },
  });
  if (!registerRes.ok) {
    const detail = await registerRes.text().catch(() => "");
    if (registerRes.status === 401) {
      throw new Error(
        `[hitch] The API key was rejected by ${config.serverUrl} (401).\n` +
          `        Sign in again via the desktop app, or set a fresh HITCH_API_KEY.`,
      );
    }
    throw new Error(
      `[hitch] Failed to register machine with ${config.serverUrl} ` +
        `(${registerRes.status}${detail ? `: ${detail}` : ""}).`,
    );
  }
  const machine = (await registerRes.json()) as { id: string };
  const machineId = machine.id;
  logger.info(
    `[hitch] V2 daemon registered machine "${name}" (${machineId}) v${version} at ${config.serverUrl}`,
  );

  // --- Heartbeat tick -------------------------------------------------------
  const tickMs = heartbeatMs(env);
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const res = await client.daemon.machines[":id"].heartbeat.$patch({
          param: { id: machineId },
          json: { daemonVersion: version },
        });
        if (!res.ok) {
          logger.error?.(`[hitch] heartbeat failed (${res.status}) for machine ${machineId}`);
        }
      } catch (error) {
        logger.error?.(`[hitch] heartbeat error: ${String(error)}`);
      }
    })();
  }, tickMs);
  // Don't keep the process alive on the tick alone.
  heartbeat.unref?.();

  // --- WebSocket ------------------------------------------------------------
  const ws: ServerWsClient = startServerWs({
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    machineId,
    logger,
  });

  // PR 1 wires the focus handler to a log line only; PR 6 makes it drive
  // cmux openChat + activateApp.
  ws.onEvent("focus", (message) => {
    logger.info(`[hitch] focus event received: ${JSON.stringify(message.payload ?? null)}`);
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    ws.stop();
  }

  return { machineId, stop };
}
