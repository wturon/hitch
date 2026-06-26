// Codex CLI running in cmux. New sessions are linked deterministically through
// Hitch's Codex hook: the daemon records an exact cwd+prompt launch claim before
// spawning Codex, and the hook consumes it when Codex reports the real session id.

import { openChat, setResumeBinding, startCommand } from "../cmux.js";
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

export function codexStartCommand(input: {
  launchId?: string;
  cwd?: string;
  prompt: string;
  model?: string;
  effort?: string;
}): string {
  const env: string[] = [];
  if (input.launchId) env.push(`HITCH_LAUNCH_ID=${input.launchId}`);
  env.push("HITCH_CHAT_ENVIRONMENT=cmux");
  return command([
    "env",
    ...env,
    ...codexBaseArgv(input),
    input.prompt,
  ]);
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
    const command = codexResumeCommand({
      threadId: ctx.sessionId,
      cwd: ctx.cwd,
    });
    const result = await openChat({
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      command,
      onSpawned: async (placement) => {
        if (!placement.surface) return;
        await setResumeBinding({
          surfaceId: placement.surface,
          workspaceId: placement.workspace,
          checkpointId: ctx.sessionId,
          cwd: ctx.cwd,
          kind: "codex",
          name: "Codex",
          source: "hitch",
          command,
        });
      },
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
    });
    return { result };
  },

  async startNew(ctx) {
    recordCodexCmuxLaunchClaim({
      launchId: ctx.launchId,
      cwd: ctx.cwd,
      prompt: ctx.prompt,
    });
    const result = await startCommand({
      taskKey: ctx.taskKey,
      cwd: ctx.cwd,
      command: codexStartCommand({
        launchId: ctx.launchId,
        cwd: ctx.cwd,
        prompt: ctx.prompt,
        model: ctx.model,
        effort: ctx.effort,
      }),
      onPlaced: (placement) => {
        updateCodexCmuxLaunchClaim({
          launchId: ctx.launchId,
          workspaceId: placement.workspace,
          surfaceId: placement.surface,
        });
      },
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
    });
    return { result };
  },
};
