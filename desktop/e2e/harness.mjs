// Launch the real Hitch Desktop app under Playwright's control, fully isolated
// from your running dev instance, so an agent (or you) can drive the UI and
// check work end-to-end. See ../../AGENTS.md → "Verifying UI changes".
//
// Isolation, the important part:
//   - Its own Chromium profile via --user-data-dir (separate Local Storage /
//     IndexedDB / lock files), so it never collides with your open dev window.
//   - Its own Hitch config (HITCH_CONFIG_PATH) pointed at an EMPTY config, so
//     startDaemon() stays idle (main.ts) and no second daemon touches your
//     project's file-sync.
//   - Its own secrets (HITCH_SECRETS_PATH) seeded from your signed-in dev
//     profile, so it boots authenticated as you with no OAuth dance. Auth tokens
//     are plain JSON in secrets.json (authStorage), so this is a file copy.
//
// The auth-loopback port (51789) is process-global; if your dev app is open it
// owns the port and this instance logs a benign "port in use" line and disables
// fresh sign-in — harmless, since we seed auth instead.
//
// Prereq: the Vite dev server is running (npm run dev:renderer, :5173). Dev mode
// loads the renderer from there, so it serves your current working tree.

import { _electron as electron } from "playwright-core";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RENDERER_URL =
  process.env.HITCH_DESKTOP_RENDERER_URL ?? "http://127.0.0.1:5173";
const REAL_SECRETS = join(
  homedir(),
  "Library/Application Support/Hitch Dev/secrets.json",
);

// Launch an isolated, signed-in instance.
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
  if (!existsSync(REAL_SECRETS)) {
    throw new Error(
      `No signed-in dev secrets at ${REAL_SECRETS}. Sign in to the dev app once first.`,
    );
  }

  const stateDir = join(tmpdir(), `hitch-e2e-${profile}`);
  if (fresh) rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const userDataDir = join(stateDir, "chromium");
  const configPath = join(stateDir, "config.json");
  const secretsPath = join(stateDir, "secrets.json");
  const preferencesPath = join(stateDir, "preferences.json");

  // Empty config → daemon idle → no conflict with your real project sync.
  writeFileSync(configPath, JSON.stringify({ hitches: [] }, null, 2));
  // Seed auth from your real signed-in profile.
  copyFileSync(REAL_SECRETS, secretsPath);

  const app = await electron.launch({
    executablePath: electronPath,
    cwd: desktopDir,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      HITCH_CONFIG_PATH: configPath,
      HITCH_SECRETS_PATH: secretsPath,
      HITCH_PREFERENCES_PATH: preferencesPath,
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
