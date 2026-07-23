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

import { openChatLifecycleStore } from "../chatLifecycleStore.js";
import { setCmuxLogger, setCmuxTraceSink } from "../cmux.js";
import { ChatStateObserver } from "../observer/index.js";
import { ChatSync } from "./chatSync.js";
import { resolveServerConfig } from "./config.js";
import { createFakeLaunchers, isFakeLaunch } from "./fakeLauncher.js";
import { createFocusHandler } from "./focus.js";
import { ProjectsProvider } from "./projects.js";
import { Reconciler } from "./reconciler.js";
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

// Chat-relay cadence: drain the reducer and push server-dirty chats to the
// server. Mirrors daemon.ts's 2s chat reduce/sync poll. The observer drives its
// own adaptive cadence (fast while a chat is active); this poll is the sink's
// floor for carrying its output to the server.
const RELAY_POLL_MS = 2_000;

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

// Fallback reconcile cadence (WS invalidations drive most passes; this is the
// floor that catches store-only changes like a turn completing, which don't
// touch the server). Overridable so the real-machine test doesn't wait 30s for
// running→waiting_input.
function reconcileMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.HITCH_RECONCILE_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

  // The focus event handler (PR 6) is wired after the fake-launch decision
  // below, so fake mode can log instead of shelling to a cmux that isn't there.

  // --- Chat-state relay (PR 2) ----------------------------------------------
  // Mirrors daemon.ts: a machine-wide chat-state observer writes discovered
  // chat state into the shared store's shadow columns, a reduce loop folds any
  // lifecycle events (e.g. the observer's dead-process heal), and the V2 sink
  // pushes server-dirty chats to the Hono server. The store is the SAME sqlite
  // file V1 uses — the server_synced_at cursor (Decision 7) keeps the two sinks
  // from contending.
  const store = openChatLifecycleStore({ env });

  // The observer maps a chat's cwd → project via the server's repo_path-bearing
  // projects. Fetch once up front so the initial reconcile has a project map,
  // then refresh whenever the server broadcasts a `projects` change.
  const projects = new ProjectsProvider({ client, logger });
  await projects.refresh();
  ws.onInvalidate("projects", () => void projects.refresh());

  // cmux.ts is dependency-free; wire its human log + per-chat trace into the
  // same streams V1 uses, so the reconciler's spawn/close calls are debuggable.
  // (Trace sink after the store is open, mirroring daemon.ts.)
  setCmuxLogger(logger);
  setCmuxTraceSink((event) => store.appendCmuxTrace(event));

  const observer = new ChatStateObserver({
    store,
    projects: projects.list,
    host: name,
    logger,
  });
  observer.start();

  const chatSync = new ChatSync({ store, client, machineId, logger });

  let relaying = false;
  async function relayTick(): Promise<void> {
    if (relaying) return;
    relaying = true;
    try {
      // Drain the reducer (events → local_chats) before syncing, so a healed
      // chat's session.ended is reflected in the row we push.
      for (;;) {
        const result = store.reduceLifecycleEvents();
        if (result.eventsReduced < 100) break;
      }
      const synced = await chatSync.sync();
      if (
        synced.created > 0 ||
        synced.updated > 0 ||
        synced.failed > 0 ||
        synced.skipped > 0
      ) {
        logger.info(
          `[hitch] chat relay: ${synced.created} created, ${synced.updated} updated, ` +
            `${synced.failed} failed, ${synced.skipped} skipped`,
        );
      }
    } catch (error) {
      logger.error?.(`[hitch] chat relay tick failed: ${String(error)}`);
    } finally {
      relaying = false;
    }
  }
  void relayTick();
  const relayTimer = setInterval(() => void relayTick(), RELAY_POLL_MS);
  relayTimer.unref?.();

  // --- Reconciler (PR 3) ----------------------------------------------------
  // Diffs desired vs ground truth and executes spawn/close/observe, writing
  // only observations. Triggers: a ~30s fallback tick (its own timer, parallel
  // to the heartbeat), a WS `assignments` invalidate ("look now"), and a WS
  // reconnect (a dropped socket may have missed invalidations — re-diff).
  // Fake-launch mode (HITCH_FAKE_LAUNCH=1, test-only): swap the reconciler's
  // launcher resolution for cmux-less stand-ins that script the chat lifecycle
  // straight into the shared store. Unset → the seam is a no-op and the real
  // registry runs. Isolate the store with HITCH_APP_SUPPORT_DIR so a fake daemon
  // never touches the real chat-lifecycle.sqlite.
  const fakeLaunch = isFakeLaunch(env)
    ? createFakeLaunchers({ store, host: name, logger, env })
    : null;
  if (fakeLaunch) {
    logger.info(
      "[hitch] HITCH_FAKE_LAUNCH=1 — spawns are simulated (no cmux, no processes).",
    );
  }

  // --- Focus relay (PR 6) ---------------------------------------------------
  // A focus event resolves the server chat's cmux session and drives cmux
  // openChat + activateApp. Fake mode injects a logging no-op so a headless run
  // never shells to cmux (the acceptance e2e asserts against this log line).
  ws.onEvent(
    "focus",
    createFocusHandler({
      client,
      machineId,
      logger,
      focus: fakeLaunch
        ? async (spec) => {
            logger.info(
              `[hitch] fake-focus: would open session ${spec.sessionId.slice(0, 8)} in cmux (no-op)`,
            );
          }
        : undefined,
    }),
  );

  const reconciler = new Reconciler({
    client,
    store,
    machineId,
    host: name,
    logger,
    tickMs: reconcileMs(env),
    resolveLauncher: fakeLaunch?.resolve,
  });
  ws.onInvalidate("assignments", () => reconciler.trigger("ws-invalidate"));

  // --- Reconnect resilience -------------------------------------------------
  // A server restart or a long WS outage means the daemon may have missed
  // invalidations AND the server may have restarted with a fresh in-memory WS
  // registry (the re-hello in ws.ts re-registers this socket). On every RE-connect
  // we run the full recovery TRIO so no manual restart is ever needed:
  //   1. RE-REGISTER the machine (idempotent upsert-by-name) — recreates the row
  //      if the server lost it and refreshes last_seen_at immediately (so the
  //      delegate bar sees us online without waiting for the next heartbeat).
  //   2. RECONCILE from scratch (reconciler.trigger) — re-diff desired vs truth,
  //      catching any assignment changes whose invalidations we missed.
  //   3. RESYNC chats (relayTick) — re-push any server-dirty chat state the
  //      server may not have (or may have lost).
  async function reregister(reason: string): Promise<void> {
    try {
      const res = await client.daemon.machines.$post({
        json: { name, daemonVersion: version },
      });
      if (!res.ok) {
        logger.error?.(`[hitch] re-register failed (${res.status}) on ${reason}`);
        return;
      }
      const row = (await res.json()) as { id: string };
      if (row.id !== machineId) {
        // The upsert-by-name returned a DIFFERENT id — the server was reset and
        // minted a new machine row. Every id-bearing call (heartbeat, chats,
        // assignments, the WS hello) still uses the id captured at startup, so a
        // process restart is required to adopt the new one. Loud, and rare.
        logger.error?.(
          `[hitch] machine re-registered with a NEW id (${row.id}) on ${reason} — ` +
            "the server appears to have been reset. Restart the daemon to adopt it.",
        );
        return;
      }
      logger.info(`[hitch] re-registered machine ${machineId} on ${reason}`);
    } catch (error) {
      logger.error?.(`[hitch] re-register error on ${reason}: ${String(error)}`);
    }
  }

  ws.onReconnect(() => {
    void (async () => {
      await reregister("ws-reconnect");
      reconciler.trigger("ws-reconnect");
      void relayTick();
    })();
  });
  reconciler.start();

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    reconciler.stop();
    fakeLaunch?.stop();
    clearInterval(heartbeat);
    clearInterval(relayTimer);
    ws.stop();
    await observer.stop();
    store.close();
  }

  return { machineId, stop };
}
