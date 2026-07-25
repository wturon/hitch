// Launch the real Hitch Desktop app under Playwright's control, fully isolated
// from your running dev instance, so an agent (or you) can drive the UI and
// check work end-to-end. See ../../AGENTS.md → "Verifying UI changes".
//
// Isolation, the important part:
//   - Its own Chromium profile via --user-data-dir (separate Local Storage /
//     IndexedDB / lock files), so it never collides with your open dev window.
//   - Its own App Support dir via HITCH_APP_SUPPORT_DIR, pointed at a scratch
//     temp dir. main.ts anchors EVERYTHING on this — secrets.json, the hook
//     spool, and the daemon it spawns (which receives the same dir) — so an
//     isolated instance never touches the real "Hitch"/"Hitch Dev" state.
//   - Its own CODEX_HOME / CLAUDE_CONFIG_DIR, also under the scratch dir. On
//     startup main.ts installs (and may migrate/auto-heal) the per-harness
//     lifecycle hook config in these dirs; without the override a check run would
//     read and rewrite the machine's real ~/.codex and ~/.claude hook config.
//   - No seeded credentials: V2 checks sign up fresh against the server
//     (HITCH_SERVER_URL), and the app persists the minted api key into the
//     scratch secrets.json.
//
// Prereq: the Vite dev server is running (npm run dev:renderer, :5173). Dev mode
// loads the renderer from there, so it serves your current working tree.

import { _electron as electron } from "playwright-core";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RENDERER_URL =
  process.env.HITCH_DESKTOP_RENDERER_URL ?? "http://127.0.0.1:5173";

// Launch an isolated instance.
//   profile: name of the temp state dir, so multiple agents can each get their
//            own (e.g. launchHitch({ profile: "agent-2" })) without colliding.
//   fresh:   wipe that temp state dir first (default true) for a clean boot.
export async function launchHitch({ profile = "default", fresh = true } = {}) {
  if (!existsSync(join(desktopDir, "dist/main/main.js"))) {
    execFileSync("npm", ["run", "build:main"], {
      cwd: desktopDir,
      stdio: "inherit",
    });
  }

  const stateDir = join(tmpdir(), `hitch-e2e-${profile}`);
  if (fresh) rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const userDataDir = join(stateDir, "chromium");
  // Give the harness installer its own hook-config homes so a check run never
  // reads or rewrites the machine's real ~/.codex and ~/.claude.
  const codexHome = join(stateDir, "codex-home");
  const claudeConfigDir = join(stateDir, "claude-config");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeConfigDir, { recursive: true });

  const app = await electron.launch({
    executablePath: electronPath,
    cwd: desktopDir,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Everything main.ts writes (secrets.json, the hook spool) and the daemon
      // it spawns are anchored on this scratch dir — full isolation.
      HITCH_APP_SUPPORT_DIR: stateDir,
      // Per-harness lifecycle-hook config the app installs on boot goes to
      // scratch dirs too, so a legacy/drifted global hook can't be mutated.
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      HITCH_DESKTOP_RENDERER_URL: RENDERER_URL,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  return {
    app,
    page,
    stateDir,
    async cleanup() {
      // app.close() can stall on Electron teardown; cap it and then hard-kill so
      // a check run always exits promptly instead of hanging with a live window.
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      try {
        app.process()?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}
