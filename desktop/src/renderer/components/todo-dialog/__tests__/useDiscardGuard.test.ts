import { describe, expect, it } from "vitest";

import { dismissAction } from "../useDiscardGuard";

// The pure half of the todo dialog's esc/dismiss machine (Todos v1 Decision 4).
// The armed bit itself is trivial useState; the DECISION is what carries the
// destructive semantics, so it's the part pinned here.
describe("dismissAction", () => {
  it("saved stage always saves and closes (esc is free)", () => {
    expect(
      dismissAction({ stage: "saved", dirty: true, armed: false }),
    ).toBe("save-and-close");
    expect(
      dismissAction({ stage: "saved", dirty: false, armed: false }),
    ).toBe("save-and-close");
    // Armed can't survive into saved (arming happens only in capture), but the
    // decision is stage-first regardless.
    expect(dismissAction({ stage: "saved", dirty: true, armed: true })).toBe(
      "save-and-close",
    );
  });

  it("clean capture closes instantly — no guard for an empty card", () => {
    expect(
      dismissAction({ stage: "capture", dirty: false, armed: false }),
    ).toBe("close");
  });

  it("dirty capture: first esc arms, second esc discards", () => {
    expect(
      dismissAction({ stage: "capture", dirty: true, armed: false }),
    ).toBe("arm");
    expect(dismissAction({ stage: "capture", dirty: true, armed: true })).toBe(
      "discard",
    );
  });

  it("a materialized-but-emptied capture still counts as dirty (caller passes dirty=true for committedPath)", () => {
    // The caller derives dirty as `body non-empty OR committedPath present`;
    // this pins the machine's behavior for that composite input.
    expect(
      dismissAction({ stage: "capture", dirty: true, armed: false }),
    ).toBe("arm");
  });
});
