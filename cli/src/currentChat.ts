import { CliError } from "./errors.js";

export interface CurrentChatIdentity {
  harness: "claude" | "codex";
  sessionId: string;
}

// Both harnesses expose their current session/thread id to commands the agent
// runs. That makes linking explicit and deterministic; no cwd, pane, timestamp,
// prompt-text, or "newest chat" guessing is needed.
export function currentChatIdentity(
  env: NodeJS.ProcessEnv = process.env,
): CurrentChatIdentity {
  const candidates: CurrentChatIdentity[] = [];
  const codex = env.CODEX_THREAD_ID?.trim();
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (codex) candidates.push({ harness: "codex", sessionId: codex });
  if (claude) candidates.push({ harness: "claude", sessionId: claude });

  if (candidates.length === 0) {
    throw new CliError(
      "No current Codex or Claude chat was detected.\n" +
        "`hitch tasks link` must be run by the agent inside the chat you want to attach.\n" +
        "To inspect the task without linking it, run:\n" +
        "  hitch tasks show <task-id> --json",
    );
  }
  if (candidates.length > 1) {
    // Claude launched from a Codex tool inherits the outer CODEX_THREAD_ID,
    // while Claude marks its own subprocesses with these variables. Prefer the
    // innermost harness rather than making this common nested-agent case a dead
    // end. With no Claude marker, ambiguity still fails closed.
    if (env.CLAUDECODE?.trim() || env.CLAUDE_CODE_ENTRYPOINT?.trim()) {
      return candidates.find((candidate) => candidate.harness === "claude")!;
    }
    throw new CliError(
      "Both Codex and Claude session ids are present, so Hitch cannot safely choose a chat.\n" +
        "Run the command directly inside the agent chat you want to attach.",
    );
  }
  return candidates[0];
}
