import { describe, expect, it } from "vitest";

import { currentChatIdentity } from "../currentChat.js";

describe("currentChatIdentity", () => {
  it("detects the Codex thread exposed to tool subprocesses", () => {
    expect(currentChatIdentity({ CODEX_THREAD_ID: " codex-thread " })).toEqual({
      harness: "codex",
      sessionId: "codex-thread",
    });
  });

  it("detects the Claude session exposed to Bash subprocesses", () => {
    expect(currentChatIdentity({ CLAUDE_CODE_SESSION_ID: "claude-session" })).toEqual({
      harness: "claude",
      sessionId: "claude-session",
    });
  });

  it("rejects commands outside an agent chat", () => {
    expect(() => currentChatIdentity({})).toThrow("No current Codex or Claude chat");
  });

  it("never guesses when nested harness variables make the chat ambiguous", () => {
    expect(() =>
      currentChatIdentity({
        CODEX_THREAD_ID: "codex-thread",
        CLAUDE_CODE_SESSION_ID: "claude-session",
      }),
    ).toThrow("--harness claude");
  });

  it("does not infer nesting direction from inherited Claude markers", () => {
    expect(() =>
      currentChatIdentity({
        CODEX_THREAD_ID: "codex-thread",
        CLAUDE_CODE_SESSION_ID: "claude-session",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli.js",
      }),
    ).toThrow("cannot safely choose");
  });

  it("selects Claude explicitly when both harness ids are present", () => {
    expect(
      currentChatIdentity(
        {
          CODEX_THREAD_ID: "codex-thread",
          CLAUDE_CODE_SESSION_ID: "claude-session",
        },
        "claude",
      ),
    ).toEqual({ harness: "claude", sessionId: "claude-session" });
  });

  it("selects Codex explicitly when both harness ids are present", () => {
    expect(
      currentChatIdentity(
        {
          CODEX_THREAD_ID: "codex-thread",
          CLAUDE_CODE_SESSION_ID: "claude-session",
          CLAUDECODE: "1",
        },
        "codex",
      ),
    ).toEqual({ harness: "codex", sessionId: "codex-thread" });
  });

  it("rejects an override whose session id is not present", () => {
    expect(() =>
      currentChatIdentity({ CLAUDE_CODE_SESSION_ID: "claude-session" }, "codex"),
    ).toThrow("No current codex chat was detected");
  });
});
