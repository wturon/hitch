// claude-code running in a VS Code-family editor extension (VS Code or Cursor).
// These are the "deep-link app" family: the extension registers a URI handler, so
// we can't enumerate its tabs or pin the session id — we open the folder, fire the
// URI, and let the editor do find/open/focus opaquely.
//
// Delivery mirrors the Codex editor launcher: we hand the URI to the editor's own
// CLI (`code --open-url <uri>`) rather than macOS `open -b <bundleId>`. The CLI
// routes to its own app, so it deterministically targets VS Code vs Cursor without
// fighting over the shared `vscode://` scheme, and uses each editor's own scheme.
//
// Because the extension owns the new session id (fire-and-forget start), startNew
// registers a CLAIM with the harness-level Claude session linker
// (claudeSessionLinker), which binds the id once the session's transcript appears.
// Linking and status are therefore identical to every other Claude environment.
//
// LIMITATIONS (intentional): startNew pre-fills the prompt but the extension does
// NOT auto-submit it (user presses Enter); the session only links once they do. No
// per-launch dedup. Whether Claude opens in a tab vs the sidebar is governed by the
// extension's own `claudeCode.preferredLocation` setting, not by us.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { registerClaudeClaim } from "./claudeSessionLinker.js";
import type { Environment, Launcher } from "./types.js";

const run = promisify(execFile);

interface EditorConfig {
  environment: Environment;
  // The extension's URI scheme host. VS Code → "vscode", Cursor → "cursor".
  uriScheme: "vscode" | "cursor";
  // Candidate paths for the editor's `code`-style CLI (opens the folder + the URI).
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
    // best-effort: the URI still launches the editor, just maybe a different window
  }
}

// Hand the URI to the editor's own CLI so it routes to that editor instance.
async function openUrl(cli: string, uri: string): Promise<void> {
  await run(cli, ["--open-url", uri], { timeout: 10_000 });
}

function makeEditorClaudeLauncher(config: EditorConfig): Launcher {
  const uriBase = `${config.uriScheme}://anthropic.claude-code/open`;
  return {
    harness: "claude-code",
    environment: config.environment,
    traits: {
      reopen: true,
      startNew: true,
      close: false,
      pinsSessionId: false, // extension owns the id → claim + discover
      autoSubmits: false, // prompt pre-fills; user presses Enter
      needsWorkspaceOpen: true,
      lifecycle: "hooks", // status comes from the global claude hooks, not a pid
      tier: 2,
    },

    async probe() {
      return { available: firstExisting(config.cliCandidates) !== null };
    },

    async reopen(ctx) {
      const cli = firstExisting(config.cliCandidates);
      if (!cli) throw new Error(`${config.environment} CLI not found`);
      await openFolder(cli, ctx.cwd);
      await openUrl(cli, `${uriBase}?session=${encodeURIComponent(ctx.sessionId)}`);
      return { result: "focused" };
    },

    async startNew(ctx) {
      const cli = firstExisting(config.cliCandidates);
      if (!cli) throw new Error(`${config.environment} CLI not found`);
      // Record the claim BEFORE firing the URI so the new session can never slip
      // past the linker. The claim is patient (no poll window), so it survives the
      // user leaving the pre-filled prompt sitting before they press Enter.
      if (ctx.cwd && ctx.logger) {
        registerClaudeClaim(
          {
            cwd: ctx.cwd,
            taskPath: ctx.taskKey,
            since: Date.now(),
            onLink: ctx.onLinked,
          },
          ctx.logger,
        );
      }
      await openFolder(cli, ctx.cwd);
      await openUrl(cli, `${uriBase}?prompt=${encodeURIComponent(ctx.prompt)}`);
      return { result: "opened-unsubmitted" };
    },
  };
}

export const vscodeClaudeLauncher = makeEditorClaudeLauncher({
  environment: "vscode",
  uriScheme: "vscode",
  cliCandidates: [
    process.env.VSCODE_BIN ?? "",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/opt/homebrew/bin/code",
    "/usr/local/bin/code",
  ],
});

// Cursor is a VS Code fork; the same anthropic.claude-code extension installs into
// it and registers a cursor:// URI handler. Discovery/status are identical to VS
// Code regardless of which editor launched the session.
export const cursorClaudeLauncher = makeEditorClaudeLauncher({
  environment: "cursor",
  uriScheme: "cursor",
  cliCandidates: [
    process.env.CURSOR_BIN ?? "",
    "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/cursor",
  ],
});
