// Launcher rails: a harness (the agent runtime) runs inside an environment (where
// it's presented — a terminal multiplexer, a native app, an editor extension). Each
// (harness, environment) pair is a Launcher that satisfies the two intents the rest
// of Hitch asks for: reopen an existing chat, or start a new one.
//
// Each launcher wraps the harness-specific mechanics in cmux.ts / codex.ts or an
// editor extension URI handler rather than making the daemon know those details.
// The interface stays declarative (traits, probe) so new environments slot in
// without reshaping the daemon.

export type Harness = "claude-code" | "codex";
export type Environment =
  | "cmux"
  | "codex-app"
  | "vscode"
  | "cursor"
  | "t3code";

// Minimal logger shape the launcher modules use, so they don't depend on daemon.ts.
export interface LauncherLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

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

// Close the presented chat — kill its tab/window in the environment. The
// harness transcript on disk is untouched, so reopen() can resume it later;
// close is always reversible. Only introspectable environments (cmux) can
// implement this; launchers that can't simply omit it.
export interface CloseCtx {
  sessionId: string;
  project: ProjectRef;
}

// Start a brand-new chat seeded with a prompt. Linking rides on callbacks because
// some harnesses (codex) only learn their session/thread id mid-launch, so the
// daemon can't link the task before the launch call returns — the launcher fires
// these as identity becomes known.
export interface StartCtx {
  launchId?: string;
  taskKey: string;
  prompt: string;
  cwd?: string;
  title?: string;
  // Kickoff-only launch parameters chosen in the compose UI. Applied when the
  // launcher spawns the harness and then owned by the harness; not all launchers
  // honor them (the Claude editor launchers can't pass them through the URI).
  model?: string;
  effort?: string;
  project: ProjectRef;
  onLinked: (sessionId: string) => Promise<void>;
  onSettled?: (sessionId: string) => Promise<void>;
  // Provided so fire-and-forget launchers (vscode/cursor) can register a claim
  // with the harness-level session linker, which links the session out-of-band.
  logger?: LauncherLogger;
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
  close: boolean; // can kill the chat's tab (the transcript survives on disk)
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
  close?(ctx: CloseCtx): Promise<LaunchOutcome>;
}
