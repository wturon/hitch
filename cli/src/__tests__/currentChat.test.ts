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
    ).toThrow("cannot safely choose");
  });
});
