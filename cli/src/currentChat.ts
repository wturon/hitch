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
  requestedHarness?: CurrentChatIdentity["harness"],
): CurrentChatIdentity {
  const candidates: CurrentChatIdentity[] = [];
  const codex = env.CODEX_THREAD_ID?.trim();
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (codex) candidates.push({ harness: "codex", sessionId: codex });
  if (claude) candidates.push({ harness: "claude", sessionId: claude });

  if (requestedHarness) {
    const requested = candidates.find((candidate) => candidate.harness === requestedHarness);
    if (!requested) {
      throw new CliError(
        `No current ${requestedHarness} chat was detected.\n` +
          `Run the command inside that ${requestedHarness} chat, or choose the other ` +
          "detected harness.",
      );
    }
    return requested;
  }

  if (candidates.length === 0) {
    throw new CliError(
      "No current Codex or Claude chat was detected.\n" +
        "`hitch tasks link` must be run by the agent inside the chat you want to attach.\n" +
        "To inspect the task without linking it, run:\n" +
        "  hitch tasks show <task-id> --json",
    );
  }
  if (candidates.length > 1) {
    throw new CliError(
      "Both Codex and Claude session ids are present, so Hitch cannot safely choose a chat.\n" +
        "Choose explicitly with `--harness claude` or `--harness codex`.",
    );
  }
  return candidates[0];
}
