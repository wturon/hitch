// claude-code running in a VS Code-family editor extension (VS Code or Cursor).
// These are the "deep-link app" family: the extension registers a URI handler, so
// we can't enumerate its tabs or pin the session id — we open the folder, fire the
// URI, and let the editor do find/open/focus opaquely.
//
// Because the extension owns the new session id (fire-and-forget start), startNew
// registers a CLAIM with the harness-level Claude session linker
// (claudeSessionLinker), which binds the id once the session's transcript appears.
// Linking and status are therefore identical to every other Claude environment.
//
// LIMITATIONS (intentional): startNew pre-fills the prompt but the extension does
// NOT auto-submit it (user presses Enter); the session only links once they do. No
// per-launch dedup. VS Code and Cursor both fork the editor, so they're distinct
// environments with their own URI scheme + app, but share the Claude linker.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";

import { registerClaudeClaim } from "./claudeSessionLinker.js";
import type { Environment, Launcher } from "./types.js";

const run = promisify(execFile);

interface EditorConfig {
  environment: Environment;
  // The extension's URI scheme host. VS Code → "vscode", Cursor → "cursor".
  uriScheme: string;
  // macOS bundle id to target explicitly (both editors register "vscode:", so we
  // must disambiguate by bundle when opening a vscode:// URI).
  bundleId: string;
  // Candidate paths for the editor's `code`-style CLI (to open the folder first).
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

// Route the URI to the specific editor by bundle id, since vscode:// is ambiguous
// when both VS Code and Cursor are installed. macOS only.
async function openUri(bundleId: string, uri: string): Promise<void> {
  if (platform() === "darwin") {
    await run("/usr/bin/open", ["-b", bundleId, uri], { timeout: 10_000 });
    return;
  }
  await run("xdg-open", [uri], { timeout: 10_000 }).catch(() => {});
}

function makeEditorClaudeLauncher(config: EditorConfig): Launcher {
  const uriBase = `${config.uriScheme}://anthropic.claude-code/open`;
  return {
    harness: "claude-code",
    environment: config.environment,
    traits: {
      reopen: true,
      startNew: true,
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
      await openFolder(cli, ctx.cwd);
      await openUri(
        config.bundleId,
        `${uriBase}?session=${encodeURIComponent(ctx.sessionId)}`,
      );
      return { result: "focused" };
    },

    async startNew(ctx) {
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
      const cli = firstExisting(config.cliCandidates);
      await openFolder(cli, ctx.cwd);
      await openUri(
        config.bundleId,
        `${uriBase}?prompt=${encodeURIComponent(ctx.prompt)}`,
      );
      return { result: "opened-unsubmitted" };
    },
  };
}

export const vscodeClaudeLauncher = makeEditorClaudeLauncher({
  environment: "vscode",
  uriScheme: "vscode",
  bundleId: "com.microsoft.VSCode",
  cliCandidates: [
    process.env.VSCODE_BIN ?? "",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/opt/homebrew/bin/code",
    "/usr/local/bin/code",
  ],
});

// Cursor is a VS Code fork; the same anthropic.claude-code extension installs into
// it and (best-effort) registers a cursor:// URI handler. Unverified end-to-end —
// shipped as an option; discovery/status are identical to VS Code regardless.
export const cursorClaudeLauncher = makeEditorClaudeLauncher({
  environment: "cursor",
  uriScheme: "cursor",
  bundleId: "com.todesktop.230313mzl4w4u92",
  cliCandidates: [
    process.env.CURSOR_BIN ?? "",
    "/Applications/Cursor.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/cursor",
  ],
});
