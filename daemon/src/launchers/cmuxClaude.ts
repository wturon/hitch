// claude-code running in cmux. Wraps the existing cmux.ts launch functions — no
// behavior change from when daemon.ts called them directly. cmux is an
// introspectable multiplexer (we can find the surface bound to a session), so this
// is the "compositional" family — but in release 1 we keep the coarse openChat /
// startChat verbs intact rather than decomposing them into find/focus primitives.

import { randomUUID } from "node:crypto";

import { openChat, startChat } from "../cmux.js";
import type { Launcher } from "./types.js";

export const cmuxClaudeLauncher: Launcher = {
  harness: "claude-code",
  environment: "cmux",
  traits: {
    reopen: true,
    startNew: true,
    pinsSessionId: true,
    autoSubmits: true,
    needsWorkspaceOpen: false,
    lifecycle: "process",
    tier: 3,
  },

  async reopen(ctx) {
    const result = await openChat({
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
    });
    return { result };
  },

  async startNew(ctx) {
    // cmux pins the session id up front (claude --session-id), so we link the task
    // before spawning — exactly the order daemon.ts used inline.
    const sessionId = randomUUID();
    await ctx.onLinked(sessionId);
    const result = await startChat({
      taskKey: ctx.taskKey,
      prompt: ctx.prompt,
      sessionId,
      cwd: ctx.cwd,
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
    });
    return { result };
  },
};
