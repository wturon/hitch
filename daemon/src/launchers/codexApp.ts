// codex running in the Codex app. Wraps startCodexChat — no behavior change from
// when daemon.ts called it directly. There is intentionally no `reopen`: codex
// resume is a `codex://threads/<id>` deep link the renderer fires straight at the
// OS (see desktop lib/chat.ts launchFor), not a daemon command. Codex is the
// "deep-link app" family — it can't be introspected, so it's intent-direct.

import { startCodexChat } from "../codex.js";
import type { Launcher } from "./types.js";

export const codexAppLauncher: Launcher = {
  harness: "codex",
  environment: "codex-app",
  traits: {
    reopen: false, // owned by the renderer's codex:// link
    startNew: true,
    pinsSessionId: true,
    autoSubmits: true,
    needsWorkspaceOpen: false,
    lifecycle: "appserver",
    tier: 3,
  },

  async startNew(ctx) {
    const started = await startCodexChat({
      taskKey: ctx.taskKey,
      prompt: ctx.prompt,
      cwd: ctx.cwd ?? "",
      threadName: ctx.title,
      onThreadStarted: ctx.onLinked,
      onTurnCompleted: ctx.onSettled,
    });
    return { result: `${started.status}:${started.threadId}` };
  },
};
