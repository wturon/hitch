// Claude Code running inside T3Code (EXPERIMENTAL). Both start and focus go
// through a Hitch-owned T3Code process over a CDP pipe — see ../t3code.ts. The
// experimental gate lives in the renderer (the environment isn't offered unless
// the flag is on); probe() reports whether the app is installed at all.

import {
  focusT3Thread,
  isT3CodeInstalled,
  readT3EnvironmentId,
  startT3Chat,
} from "../t3code.js";
import type { Launcher } from "./types.js";

export const t3codeClaudeLauncher: Launcher = {
  harness: "claude-code",
  environment: "t3code",
  traits: {
    reopen: true,
    startNew: true,
    pinsSessionId: true, // we generate the threadId in the dispatch command
    autoSubmits: true, // thread.turn.start runs the first turn
    needsWorkspaceOpen: false,
    lifecycle: "appserver", // status comes from T3Code's snapshot, not hooks/pid
    tier: 2, // locate+focus, conditional on Hitch owning the launch
  },

  async probe() {
    return isT3CodeInstalled()
      ? { available: true }
      : { available: false, reason: "T3Code is not installed in /Applications" };
  },

  async reopen(ctx) {
    const environmentId = readT3EnvironmentId();
    if (!environmentId) return { result: "unavailable" };
    const outcome = await focusT3Thread({ environmentId, threadId: ctx.sessionId });
    return { result: outcome.kind };
  },

  async startNew(ctx) {
    const started = await startT3Chat({
      taskKey: ctx.taskKey,
      prompt: ctx.prompt,
      cwd: ctx.cwd ?? "",
      harness: "claude-code",
      threadName: ctx.title,
      model: ctx.model,
      effort: ctx.effort,
      onLinked: (threadId) => ctx.onLinked(threadId),
    });
    return { result: `started:${started.threadId}` };
  },
};
