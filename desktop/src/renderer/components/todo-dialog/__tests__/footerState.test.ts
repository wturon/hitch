import { describe, expect, it } from "vitest";

import { selectSavedFooterState } from "../footerState";
import type { DelegationRequest } from "@/lib/chat";

const requested: DelegationRequest = { state: "requested", harness: "codex" };
const failed: DelegationRequest = {
  state: "failed",
  harness: "claude-code",
  error: "exited before binding",
};

// The saved-stage footer selector (Todos v1, slice 5). Its precedence — completed
// over chat over request over compose — is the load-bearing decision; the ⌘⏎
// arming and chrome live in the components, so this pins only the selection.
describe("selectSavedFooterState", () => {
  it("no chat, no request, not completed → compose", () => {
    expect(
      selectSavedFooterState({
        hasChat: false,
        request: null,
        completed: false,
      }),
    ).toBe("compose");
  });

  it("chat attached → linked", () => {
    expect(
      selectSavedFooterState({ hasChat: true, request: null, completed: false }),
    ).toBe("linked");
  });

  it("requested flag (no chat) → requested", () => {
    expect(
      selectSavedFooterState({
        hasChat: false,
        request: requested,
        completed: false,
      }),
    ).toBe("requested");
  });

  it("failed flag (no chat) → failed", () => {
    expect(
      selectSavedFooterState({
        hasChat: false,
        request: failed,
        completed: false,
      }),
    ).toBe("failed");
  });

  it("completed with a linked chat → linked-completed (ghosted chip)", () => {
    expect(
      selectSavedFooterState({ hasChat: true, request: null, completed: true }),
    ).toBe("linked-completed");
  });

  it("completed with NO chat → none (no footer band)", () => {
    expect(
      selectSavedFooterState({
        hasChat: false,
        request: null,
        completed: true,
      }),
    ).toBe("none");
  });

  it("completed wins over a lingering request (done predicate is checked first)", () => {
    expect(
      selectSavedFooterState({
        hasChat: false,
        request: requested,
        completed: true,
      }),
    ).toBe("none");
    expect(
      selectSavedFooterState({
        hasChat: true,
        request: requested,
        completed: true,
      }),
    ).toBe("linked-completed");
  });

  it("an attached chat wins over a lingering request (mirrors DelegationBand)", () => {
    expect(
      selectSavedFooterState({
        hasChat: true,
        request: requested,
        completed: false,
      }),
    ).toBe("linked");
  });
});
