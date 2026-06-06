// The launcher registry: resolve a (harness, environment) pair to its Launcher.
// Release 1 has one environment per harness, so environment is derived from the
// harness default when a command doesn't specify one (it never does yet). The
// optional `environment` argument is the seam release 2 uses once a per-harness
// preference (and per-task override) exists.

import { cmuxClaudeLauncher } from "./cmuxClaude.js";
import { codexAppLauncher } from "./codexApp.js";
import { cursorClaudeLauncher, vscodeClaudeLauncher } from "./editorClaude.js";
import { cursorCodexLauncher, vscodeCodexLauncher } from "./editorCodex.js";
import type { Environment, Harness, Launcher } from "./types.js";

const LAUNCHERS: Launcher[] = [
  cmuxClaudeLauncher,
  codexAppLauncher,
  vscodeClaudeLauncher,
  cursorClaudeLauncher,
  vscodeCodexLauncher,
  cursorCodexLauncher,
];

const BY_KEY = new Map<string, Launcher>(
  LAUNCHERS.map((launcher) => [
    `${launcher.harness}:${launcher.environment}`,
    launcher,
  ]),
);

const DEFAULT_ENVIRONMENT: Record<Harness, Environment> = {
  "claude-code": "cmux",
  codex: "codex-app",
};

export function defaultEnvironment(harness: Harness): Environment | undefined {
  return DEFAULT_ENVIRONMENT[harness];
}

export function resolveLauncher(
  harness: Harness,
  environment?: Environment,
): Launcher | undefined {
  const env = environment ?? DEFAULT_ENVIRONMENT[harness];
  if (!env) return undefined;
  return BY_KEY.get(`${harness}:${env}`);
}

export function launchers(): readonly Launcher[] {
  return LAUNCHERS;
}
