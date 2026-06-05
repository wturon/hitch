// Launcher rails: a harness (the agent runtime) runs inside an environment (where
// it's presented — a terminal multiplexer, a native app, an editor extension). Each
// (harness, environment) pair is a Launcher that satisfies the two intents the rest
// of Hitch asks for: reopen an existing chat, or start a new one.
//
// Release 1 keeps today's behavior exactly: the only launchers are claude-code:cmux
// and codex:codex-app, and each wraps the existing cmux.ts / codex.ts code rather
// than re-implementing it. The interface is intentionally forward-looking (traits,
// probe) so new environments slot in without reshaping the daemon.

export type Harness = "claude-code" | "codex";
export type Environment = "cmux" | "codex-app";

export interface ProjectRef {
  projectId: string;
  projectName: string;
}

// Reopen/focus an already-linked chat.
export interface ReopenCtx {
  sessionId: string;
  cwd?: string;
  project: ProjectRef;
}

// Start a brand-new chat seeded with a prompt. Linking rides on callbacks because
// some harnesses (codex) only learn their session/thread id mid-launch, so the
// daemon can't link the task before the launch call returns — the launcher fires
// these as identity becomes known.
export interface StartCtx {
  taskKey: string;
  prompt: string;
  cwd?: string;
  title?: string;
  project: ProjectRef;
  onLinked: (sessionId: string) => Promise<void>;
  onSettled?: (sessionId: string) => Promise<void>;
}

export interface LaunchOutcome {
  // Recorded verbatim on the command. Preserves today's values so existing
  // logging/consumers don't shift (e.g. "focused" | "spawned" | "started:<id>").
  result: string;
}

// Declarative metadata about what a launcher can do, read without side effects.
// Unused by the daemon's control flow in release 1; it documents the model and is
// the seam the settings UI / fallback logic grow into.
export interface LauncherTraits {
  reopen: boolean;
  startNew: boolean;
  pinsSessionId: boolean; // we choose the id up front → can pre-link the task
  autoSubmits: boolean; // startNew runs the first turn vs. user presses Enter
  needsWorkspaceOpen: boolean; // reopen needs the folder already open (vscode)
  lifecycle: "process" | "appserver" | "hooks" | "none";
  tier: 0 | 1 | 2 | 3; // link-only / launch / locate+focus / full
}

export interface Launcher {
  harness: Harness;
  environment: Environment;
  traits: LauncherTraits;
  // Is this environment usable on this machine right now? Optional; unused in
  // release 1 (cmux availability is still discovered at call time via CmuxError).
  probe?(): Promise<{ available: boolean; reason?: string }>;
  reopen?(ctx: ReopenCtx): Promise<LaunchOutcome>;
  startNew?(ctx: StartCtx): Promise<LaunchOutcome>;
}
