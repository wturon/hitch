import { describe, expect, it } from "vitest";

import { dismissAction } from "../useDiscardGuard";

// The pure half of the todo dialog's dismiss machine.
describe("dismissAction", () => {
  it("saved stage always saves and closes (esc is free)", () => {
    expect(dismissAction({ stage: "saved" })).toBe("save-and-close");
  });

  it("capture closes instantly without a second Escape confirmation", () => {
    expect(dismissAction({ stage: "capture" })).toBe("close");
  });
});
