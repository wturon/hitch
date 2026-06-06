// Codex running in a VS Code-family editor extension (VS Code or Cursor).
// Hitch still owns thread creation through codex app-server so it can link the
// task immediately; the editor extension is focused with its URI handler once
// the thread id exists.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { startCodexChat } from "../codex.js";
import type { Environment, Launcher } from "./types.js";

const run = promisify(execFile);

interface EditorConfig {
  environment: Environment;
  uriScheme: "vscode" | "cursor";
  cliCandidates: string[];
}

function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (!p) continue;
    if (existsSync(p)) return p;
  }
  return null;
}

async function openFolder(cli: string | null, cwd?: string): Promise<void> {
  if (!cli || !cwd) return;
  try {
    await run(cli, [cwd], { timeout: 10_000 });
  } catch {
    // best-effort: the URI still launches/focuses the editor extension
  }
}

async function openExtensionThread(
  config: EditorConfig,
  threadId: string,
): Promise<void> {
  const cli = firstExisting(config.cliCandidates);
  if (!cli) throw new Error(`${config.environment} CLI not found`);
  const uri = `${config.uriScheme}://openai.chatgpt/local/${encodeURIComponent(threadId)}`;
  await run(cli, ["--open-url", uri], { timeout: 10_000 });
}

async function focusExtensionThread(
  config: EditorConfig,
  cli: string | null,
  threadId: string,
  cwd?: string,
): Promise<void> {
  await openFolder(cli, cwd);
  await openExtensionThread(config, threadId);
}

function makeEditorCodexLauncher(config: EditorConfig): Launcher {
  return {
    harness: "codex",
    environment: config.environment,
    traits: {
      reopen: true,
      startNew: true,
      pinsSessionId: true,
      autoSubmits: true,
      needsWorkspaceOpen: true,
      lifecycle: "appserver",
      tier: 3,
    },

    async probe() {
      return { available: firstExisting(config.cliCandidates) !== null };
    },

    async reopen(ctx) {
      const cli = firstExisting(config.cliCandidates);
      await focusExtensionThread(config, cli, ctx.sessionId, ctx.cwd);
      return { result: "focused" };
    },

    async startNew(ctx) {
      const cli = firstExisting(config.cliCandidates);
      if (!cli) throw new Error(`${config.environment} CLI not found`);
      const started = await startCodexChat({
        taskKey: ctx.taskKey,
        prompt: ctx.prompt,
        cwd: ctx.cwd ?? "",
        threadName: ctx.title,
        onThreadStarted: async (threadId) => {
          await ctx.onLinked(threadId);
          try {
            await focusExtensionThread(config, cli, threadId, ctx.cwd);
          } catch (err) {
            const message = `[hitch] linked codex thread ${threadId}, but could not focus ${config.environment}: ${String(err)}`;
            (ctx.logger?.error ?? ctx.logger?.info)?.(message);
          }
        },
        onTurnCompleted: ctx.onSettled,
      });
      return { result: `${started.status}:${started.threadId}` };
    },
  };
}

export const vscodeCodexLauncher = makeEditorCodexLauncher({
  environment: "vscode",
  uriScheme: "vscode",
  cliCandidates: [
    process.env.VSCODE_BIN ?? "",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/opt/homebrew/bin/code",
    "/usr/local/bin/code",
  ],
});

export const cursorCodexLauncher = makeEditorCodexLauncher({
  environment: "cursor",
  uriScheme: "cursor",
  cliCandidates: [
    process.env.CURSOR_BIN ?? "",
    "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/cursor",
  ],
});
