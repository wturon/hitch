// Fake launchers for headless V2 e2e (M4 PR 4). TEST-ONLY — active only when
// HITCH_FAKE_LAUNCH=1, and a strict no-op otherwise (the resolver falls straight
// through to the real registry, so an unset flag is byte-for-byte the real path).
//
// A fake launcher is Launcher-shaped for a (harness, cmux) pair but never touches
// cmux, a process, or the filesystem. It drives a scripted chat lifecycle so the
// full reconcile loop — pending → spawning → running → waiting_input → done —
// runs on a CI box with no cmux and no agent binary.
//
// V3/phase-D NOTE: there is no local chat store to script into any more. A fake
// chat is now a fake OBSERVATION: the launcher registers it with the attachment
// layer and moves its axes, and it reaches the server through the same snapshot
// PUT every real chat does. That means the loop it exercises is the real one end
// to end — including the server's status function and its death sweep — instead
// of stopping at a local row.
//
//   startNew → the reconciler's `onLinked` pre-registers the session; we flip it
//              to running/working, then (after a test-only delay) to running/idle,
//              which the server reads as `idle` and the reconciler maps to
//              waiting_input — "the agent finished a pass".
//   close    → release the chat. It leaves the snapshot, the server's sweep marks
//              it dead, and the reconciler settles the assignment to done.
//
// STILL HEAL-PROOF: a fake session has no transcript, no thread and no pidfile,
// so real observation never discovers it and can never contradict the script.
// The only thing that can move these axes is this file.

import { randomUUID } from "node:crypto";

import type { AttachmentLayer } from "../attachment/index.js";
import { resolveLauncher } from "../launchers/registry.js";
import type { Environment, Harness, Launcher } from "../launchers/types.js";
import type { SnapshotHarness } from "../observer/types.js";

// Delay from bind → turn.completed. Short by default so a headless loop lands
// quickly; overridable for a slower/observable run.
const DEFAULT_DELAY_MS = 1_500;

export interface FakeLauncherLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface FakeLauncherDeps {
  attachments: AttachmentLayer;
  logger: FakeLauncherLogger;
  env?: NodeJS.ProcessEnv;
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
// advertise. Both fakes pin their session id (they mint it), which is the one
// deliberate difference from real codex — see the header.
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

const wireHarness = (harness: Harness): SnapshotHarness =>
  harness === "codex" ? "codex" : "claude";

/**
 * Build the fake-launch controller. `resolve` is a launcher resolver the
 * reconciler uses in place of the registry; `stop` cancels pending timers.
 */
export function createFakeLaunchers(deps: FakeLauncherDeps): FakeLaunchController {
  const env = deps.env ?? process.env;
  const delay = fakeDelayMs(env);
  const { attachments, logger } = deps;

  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  // Run `fn` after the scripted delay unless we've been torn down.
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

  function makeLauncher(harness: Harness): Launcher {
    const wire = wireHarness(harness);
    return {
      harness,
      environment: "cmux",
      traits: cmuxTraits(harness === "claude-code"),

      async startNew(ctx) {
        // Mint an id and bind up front — mirrors the real cmux claude launcher,
        // which calls onLinked BEFORE the spawn. The reconciler's onLinked
        // pre-registers the session with the attachment layer, which is what
        // puts it in the next snapshot.
        const sessionId = randomUUID();
        await ctx.onLinked(sessionId);
        // …and immediately "discovered", working on its first turn.
        attachments.simulate({ harness: wire, sessionId, existence: "running", activity: "working" });

        logger.info(
          `[hitch] fake-launch: ${harness} session ${sessionId.slice(0, 8)} bound (no real spawn)`,
        );

        // The one scripted transition: a turn completes → running+idle → the
        // server reads `idle` → the reconciler observes waiting_input.
        schedule(() => {
          if (!attachments.simulate({ harness: wire, sessionId, activity: "idle" })) return;
          logger.info(
            `[hitch] fake-launch: ${harness} ${sessionId.slice(0, 8)} turn completed → waiting_input`,
          );
        });

        return { result: `fake-started:${sessionId}` };
      },

      async close(ctx) {
        // Stop reporting it. Absence from the snapshot IS death (§5 rule 4), so
        // the server marks the chat dead exactly as it would for a real tab.
        attachments.release(wire, ctx.sessionId);
        logger.info(
          `[hitch] fake-launch: ${harness} ${ctx.sessionId.slice(0, 8)} closed → session ended`,
        );
        return { result: `fake-closed:${ctx.sessionId}` };
      },
    };
  }

  const fakeByHarness: Record<string, Launcher> = {
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
      return fakeByHarness[harness] ?? resolveLauncher(harness, environment);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
