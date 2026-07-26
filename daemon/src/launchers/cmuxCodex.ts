// Codex CLI running in cmux. New sessions are linked deterministically through
// Hitch's Codex hook: the daemon exports a launch nonce (HITCH_LAUNCH_ID) on the
// Codex command, Codex passes its environment down to its hook processes, and
// the hook reports that nonce alongside Codex's own session id — which is where
// the attachment layer joins them (daemon/src/attachment/).
//
// This replaced a cmux SURFACE-id join. The surface was unique per pane and the
// match was exact, but it made chat identity a function of the ENVIRONMENT the
// chat ran in: a Codex chat outside cmux could never be attached, and cmux's
// pane model leaked into the chat model. The nonce is ours, travels on our own
// process, and works in any terminal — cmux is now only asked where to DISPLAY a
// chat, never which chat it is.

import { recordCmuxLaunch } from "../attachment/launches.js";
import { closeChat, openChat, startCommand } from "../cmux.js";
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

// `HITCH_LAUNCH_ID=<nonce> codex …` — the join key, set as a shell assignment
// prefix on the command line cmux types into the pane. Three things make that
// safe: cmux `send`s this as literal shell text (daemon/src/cmux.ts placeChat),
// it detects Codex through its own PATH shim rather than by parsing our string,
// and Codex exports its environment to every hook process it spawns.
//
// No `HITCH_CHAT_ENVIRONMENT=cmux`: the environment belongs to the launch record
// the daemon already holds, not to the harness's environment block.
export function codexStartCommand(input: {
  cwd?: string;
  prompt: string;
  model?: string;
  effort?: string;
  launchId?: string;
}): string {
  const argv = [...codexBaseArgv(input), input.prompt];
  const line = command(argv);
  return input.launchId ? `HITCH_LAUNCH_ID=${shellQuote(input.launchId)} ${line}` : line;
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
    close: true,
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
    recordCmuxLaunch({ launchId: ctx.launchId, harness: "codex" });
    // No `beforeCommand`: nothing needs the surface id before Codex runs any
    // more, so this drops back to cmux's atomic `new-workspace --command` form
    // (the path Claude and resume already take) instead of the
    // create-then-send split that existed only to stamp a surface.
    const result = await startCommand({
      taskKey: ctx.taskKey,
      cwd: ctx.cwd,
      command: codexStartCommand({
        cwd: ctx.cwd,
        prompt: ctx.prompt,
        model: ctx.model,
        effort: ctx.effort,
        launchId: ctx.launchId,
      }),
      projectId: ctx.project.projectId,
      projectName: ctx.project.projectName,
    });
    return { result };
  },

  // The cmux resume binding keys on the harness-native chat id for Codex too
  // (checkpoint_id = thread id), so the same scan-and-close works unchanged.
  async close(ctx) {
    const result = await closeChat({ sessionId: ctx.sessionId });
    return { result };
  },
};
