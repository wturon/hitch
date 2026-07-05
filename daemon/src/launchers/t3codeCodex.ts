// Codex running inside T3Code (EXPERIMENTAL). Mirrors t3codeClaude — the only
// difference is the harness (T3Code provider instance `codex` vs `claudeAgent`).
// Both start and focus go through a Hitch-owned T3Code process over a CDP pipe.

import {
  focusT3Thread,
  isT3CodeInstalled,
  readT3EnvironmentId,
  startT3Chat,
} from "../t3code.js";
import type { Launcher } from "./types.js";

export const t3codeCodexLauncher: Launcher = {
  harness: "codex",
  environment: "t3code",
  traits: {
    reopen: true,
    startNew: true,
    close: false,
    pinsSessionId: true,
    autoSubmits: true,
    needsWorkspaceOpen: false,
    lifecycle: "appserver",
    tier: 2,
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
      harness: "codex",
      threadName: ctx.title,
      model: ctx.model,
      effort: ctx.effort,
      onLinked: (threadId) => ctx.onLinked(threadId),
    });
    return { result: `started:${started.threadId}` };
  },
};
