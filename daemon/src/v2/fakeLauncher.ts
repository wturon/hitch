// Fake launchers for headless V2 e2e (M4 PR 4). TEST-ONLY — active only when
// HITCH_FAKE_LAUNCH=1, and a strict no-op otherwise (the resolver falls straight
// through to the real registry, so an unset flag is byte-for-byte the real path).
//
// A fake launcher is Launcher-shaped for a (harness, cmux) pair but never touches
// cmux, a process, or the filesystem. It drives a scripted chat lifecycle into the
// SAME chatLifecycleStore the reconciler reads, so the full reconcile loop —
// pending → spawning → running → waiting_input → done — runs on a CI box with no
// cmux and no agent binary.
//
// The lifecycle mirrors the real flow:
//   - startNew: the reconciler's `onLinked` writes the bound `working` store row +
//     posts the server chat + marks the assignment `spawning` (unchanged). We then
//     schedule ONE turn completion after a short test-only delay, so the row folds
//     to `waiting` and the reconciler observes `waiting_input` ("agent finished a
//     pass"). This is the plan's exempted business timer — test-only.
//   - close: settle the row (status idle + endedAt), so the reconciler's close path
//     settles the assignment to `done`.
//
// V3 NOTE: this used to script the lifecycle through `DaemonLifecycleProducer` →
// the event ledger → the reducer. That whole path is gone (the daemon has no local
// event ledger any more), so the scripted transitions now write the `local_chats`
// row the reconciler reads DIRECTLY. Same observable loop, one layer fewer.
//
// HEAL-PROOF BY CONSTRUCTION: a fake session has no transcript, no thread and no
// pidfile, so the chat observer never discovers it and can never contradict the
// script behind our back.

import { randomUUID } from "node:crypto";

import type {
  ChatLifecycleHarness,
  ChatLifecycleStatus,
  ChatLifecycleStore,
} from "../chatLifecycleStore.js";
import { resolveLauncher } from "../launchers/registry.js";
import type { Environment, Harness, Launcher } from "../launchers/types.js";

// Delay from bind → turn.completed. Short by default so a headless loop lands
// quickly; overridable for a slower/observable run.
const DEFAULT_DELAY_MS = 1_500;

export interface FakeLauncherLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface FakeLauncherDeps {
  store: ChatLifecycleStore;
  host: string;
  logger: FakeLauncherLogger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

// A resolver with the registry's exact shape, so it drops into the reconciler's
// `resolveLauncher` seam unchanged.
export type LauncherResolver = (
  harness: Harness,
  environment?: Environment,
) => Launcher | undefined;

export interface FakeLaunchController {
  /** Drop-in for the registry's resolveLauncher — fakes cmux, else falls through. */
  resolve: LauncherResolver;
  /** Cancel any pending scripted-lifecycle timers (call on daemon shutdown). */
  stop: () => void;
}

/** Whether this launch should simulate spawns instead of touching cmux. */
export function isFakeLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HITCH_FAKE_LAUNCH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function fakeDelayMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HITCH_FAKE_LAUNCH_DELAY_MS?.trim();
  if (!raw) return DEFAULT_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;
}

// Shared cmux-family traits: same capability surface the real cmux launchers
// advertise (pinsSessionId differs per harness, matching cmuxClaude/cmuxCodex).
function cmuxTraits(pinsSessionId: boolean): Launcher["traits"] {
  return {
    reopen: true,
    startNew: true,
    close: true,
    pinsSessionId,
    autoSubmits: true,
    needsWorkspaceOpen: false,
    lifecycle: pinsSessionId ? "process" : "hooks",
    tier: 3,
  };
}

/**
 * Build the fake-launch controller. `resolve` is a launcher resolver the
 * reconciler uses in place of the registry; `stop` cancels pending timers.
 */
export function createFakeLaunchers(deps: FakeLauncherDeps): FakeLaunchController {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const delay = fakeDelayMs(env);
  const { store, host, logger } = deps;

  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  // Move an already-bound row to the next scripted state. Reads the row the
  // reconciler wrote at `onLinked` and rewrites it — a no-op when the row isn't
  // there (a torn-down daemon, or a close for a chat that never bound).
  function advance(
    harness: ChatLifecycleHarness,
    sessionId: string,
    patch: { status: ChatLifecycleStatus; endedAt?: number | null },
  ): boolean {
    const localKey = `chat:${harness}:${host}:${sessionId}`;
    const row = store.getLocalChat(localKey);
    if (!row) return false;
    const at = now();
    store.upsertLocalChat({
      ...row,
      status: patch.status,
      lastEventAt: at,
      lastStatusAt: at,
      endedAt: patch.endedAt !== undefined ? patch.endedAt : row.endedAt,
      updatedAt: at,
    });
    return true;
  }

  // Run `fn` after the scripted delay unless we've been torn down. Guarded so a
  // late-firing timer that races a store.close() can't throw into the loop.
  function schedule(fn: () => void): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      try {
        fn();
      } catch (error) {
        logger.error?.(`[hitch] fake-launch scripted event failed: ${String(error)}`);
      }
    }, delay);
    timers.add(timer);
  }

  function makeLauncher(harness: ChatLifecycleHarness): Launcher {
    return {
      harness,
      environment: "cmux",
      traits: cmuxTraits(harness === "claude-code"),

      async startNew(ctx) {
        // Mint an id and bind up front — mirrors the real cmux launchers, which
        // call onLinked BEFORE the spawn. The reconciler's onLinked writes the
        // `working` store row, POSTs the server chat, and marks the assignment
        // `spawning`. (For codex the reconciler already created the launch row;
        // onLinked rekeys it to the chat id and updates the server cmux_ref.)
        const sessionId = randomUUID();
        await ctx.onLinked(sessionId);

        logger.info(
          `[hitch] fake-launch: ${harness} session ${sessionId.slice(0, 8)} bound (no real spawn)`,
        );

        // The one scripted transition: after a short delay, a turn completes →
        // the row folds to `waiting` → the reconciler observes `waiting_input`.
        schedule(() => {
          if (!advance(harness, sessionId, { status: "waiting" })) return;
          logger.info(
            `[hitch] fake-launch: ${harness} ${sessionId.slice(0, 8)} turn completed → waiting_input`,
          );
        });

        return { result: `fake-started:${sessionId}` };
      },

      async close(ctx) {
        // Settle the row (idle + endedAt) so the reconciler's close path PATCHes
        // the assignment to `done`.
        advance(harness, ctx.sessionId, { status: "idle", endedAt: now() });
        logger.info(
          `[hitch] fake-launch: ${harness} ${ctx.sessionId.slice(0, 8)} closed → session ended`,
        );
        return { result: `fake-closed:${ctx.sessionId}` };
      },
    };
  }

  const fakeByHarness: Record<ChatLifecycleHarness, Launcher> = {
    "claude-code": makeLauncher("claude-code"),
    codex: makeLauncher("codex"),
  };

  return {
    resolve(harness, environment) {
      // Only fake the cmux family (all V2 spawns are cmux — Decision 5). Anything
      // else falls straight through to the real registry.
      if (environment && environment !== "cmux") {
        return resolveLauncher(harness, environment);
      }
      const fake = fakeByHarness[harness as ChatLifecycleHarness];
      return fake ?? resolveLauncher(harness, environment);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
