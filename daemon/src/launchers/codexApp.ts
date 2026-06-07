// Codex running in the Codex app. The daemon owns both start and reopen now so
// the renderer can issue a single open-chat command and let launcher preferences
// decide whether Codex opens in the native app, VS Code, or Cursor.

import { openCodexThread, startCodexChat } from "../codex.js";
import type { Launcher } from "./types.js";

export const codexAppLauncher: Launcher = {
  harness: "codex",
  environment: "codex-app",
  traits: {
    reopen: true,
    startNew: true,
    pinsSessionId: true,
    autoSubmits: true,
    needsWorkspaceOpen: false,
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
      threadName: ctx.title,
      model: ctx.model,
      effort: ctx.effort,
      onThreadStarted: ctx.onLinked,
      onTurnCompleted: ctx.onSettled,
    });
    return { result: `${started.status}:${started.threadId}` };
  },
};
