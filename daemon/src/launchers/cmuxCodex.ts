// Codex CLI running in cmux. New sessions are linked deterministically through
// Hitch's Codex hook: the daemon records an exact cwd+prompt launch claim before
// spawning Codex, and the hook consumes it when Codex reports the real session id.

import { openChat, startCommand } from "../cmux.js";
import {
  recordCodexCmuxLaunchClaim,
  updateCodexCmuxLaunchClaim,
} from "../codexCmuxLaunchClaims.js";
import { codexBin } from "../codex.js";
import type { Launcher } from "./types.js";

function shellQuote(value: string): string {
  if (!/[^A-Za-z0-9_./:-]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function command(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function codexBaseArgv(input: {
  cwd?: string;
  model?: string;
  effort?: string;
}): string[] {
  const argv = [codexBin()];
  if (input.cwd) argv.push("-C", input.cwd);
  if (input.model) argv.push("--model", input.model);
  if (input.effort) {
    argv.push("-c", `model_reasoning_effort="${input.effort}"`);
  }
  return argv;
}

// No `env HITCH_LAUNCH_ID=… HITCH_CHAT_ENVIRONMENT=cmux` prefix: the hook infers
// the cmux environment from CMUX_SURFACE_ID (cmux injects it per pane) and
// correlates the launch via the surface-keyed claim (the surface is stamped onto
// the claim before this command runs), so the command is just plain Codex.
export function codexStartCommand(input: {
  cwd?: string;
  prompt: string;
  model?: string;
  effort?: string;
}): string {
  return command([...codexBaseArgv(input), input.prompt]);
}

function codexResumeArgv(input: {
  threadId: string;
  cwd?: string;
  model?: string;
  effort?: string;
}): string[] {
  const argv = [codexBin(), "resume"];
  if (input.cwd) argv.push("-C", input.cwd);
  if (input.model) argv.push("--model", input.model);
  if (input.effort) argv.push("-c", `model_reasoning_effort="${input.effort}"`);
  argv.push(input.threadId);
  return argv;
}

export function codexResumeCommand(input: {
  threadId: string;
  cwd?: string;
  model?: string;
  effort?: string;
}): string {
  return command(codexResumeArgv(input));
}

export const cmuxCodexLauncher: Launcher = {
  harness: "codex",
  environment: "cmux",
  traits: {
    reopen: true,
    startNew: true,
    pinsSessionId: false,
    autoSubmits: true,
    needsWorkspaceOpen: false,
    lifecycle: "hooks",
    tier: 3,
  },

  async reopen(ctx) {
    // We no longer propose a resume command to cmux here. cmux's own Codex hook
    // owns the per-surface resume binding (installed at desktop startup), so it
    // captures the launch natively and trusts it — the way the Claude wrapper
    // does. Proposing our own `codex resume <threadId>` carried a per-thread
    // prefix that never matched a prior approval, so cmux popped "Allow Resume
    // Command?" every time. We still drive our own `codex resume <id>` for the
    // closed case (the `command` below); we just don't register it with cmux.
    const command = codexResumeCommand({
      threadId: ctx.sessionId,
      cwd: ctx.cwd,
    });
    const result = await openChat({
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      command,
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
    });
    return { result };
  },

  async startNew(ctx) {
    recordCodexCmuxLaunchClaim({ launchId: ctx.launchId });
    const result = await startCommand({
      taskKey: ctx.taskKey,
      cwd: ctx.cwd,
      command: codexStartCommand({
        cwd: ctx.cwd,
        prompt: ctx.prompt,
        model: ctx.model,
        effort: ctx.effort,
      }),
      // Stamp the surface onto the claim BEFORE Codex runs (not after, via
      // onPlaced). Codex's hook can fire UserPromptSubmit before a post-launch
      // stamp lands, and since the hook only consumes the claim on that first
      // event, a miss is unrecoverable — so the join key must exist up front.
      // record/update are synchronous file writes, so concurrent launches each
      // stamp their own surface without racing.
      beforeCommand: (surfaceId) => {
        updateCodexCmuxLaunchClaim({
          launchId: ctx.launchId,
          surfaceId,
        });
      },
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
      launchId: ctx.launchId,
    });
    return { result };
  },
};
