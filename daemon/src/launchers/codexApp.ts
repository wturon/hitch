// Codex running in the Codex app. The daemon owns both start and reopen, so the
// renderer issues a single open-chat command and the registry picks the
// launcher. Not reachable from the V2 reconciler, which always resolves cmux —
// this is the registry's per-harness default and the seam a native-app run would
// come back through.

import { openCodexThread, startCodexChat } from "../codex.js";
import type { Launcher } from "./types.js";

export const codexAppLauncher: Launcher = {
  harness: "codex",
  environment: "codex-app",
  traits: {
    reopen: true,
    startNew: true,
    close: false,
    pinsSessionId: true,
    autoSubmits: true,
    lifecycle: "appserver",
    tier: 3,
  },

  async reopen(ctx) {
    await openCodexThread(ctx.sessionId);
    return { result: "focused" };
  },

  async startNew(ctx) {
    const started = await startCodexChat({
      taskKey: ctx.taskKey,
      prompt: ctx.prompt,
      cwd: ctx.cwd ?? "",
      model: ctx.model,
      effort: ctx.effort,
      onThreadStarted: ctx.onLinked,
      onTurnCompleted: ctx.onSettled,
    });
    return { result: `${started.status}:${started.threadId}` };
  },
};
