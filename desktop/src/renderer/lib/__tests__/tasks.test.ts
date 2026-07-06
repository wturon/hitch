import { describe, expect, it } from "vitest";

import { deriveTitleFromBody } from "../tasks";

// The capture flow's title mechanism (Todos v1 revised — splitCaptureText is
// gone). New invariant: capture text is sacred; the title is additive metadata;
// nothing is ever moved out of the body. The body always holds the verbatim
// capture text, and the title is a NON-DESTRUCTIVE seed derived from the body's
// first ~6 words (later upgraded by the generate-title pipeline). These tests
// pin that derivation — the body itself is never mutated by deriving a title, so
// there's nothing else to assert about a one-liner vs. a multi-line capture: the
// body is whatever the user typed.
describe("deriveTitleFromBody", () => {
  it("one-liner: first ~6 words become the seed (body stays whole)", () => {
    expect(deriveTitleFromBody("Fix the drag ghost")).toBe("Fix the drag ghost");
  });

  it("caps at maxWords (default 6)", () => {
    expect(
      deriveTitleFromBody(
        "Fix the drag ghost when reordering backlog rows across groups",
      ),
    ).toBe("Fix the drag ghost when reordering");
  });

  it("multi-line: seeds from the first non-empty line only", () => {
    expect(
      deriveTitleFromBody(
        "Fix the drag ghost when reordering\nIt flickers on group boundaries.",
      ),
    ).toBe("Fix the drag ghost when reordering");
  });

  it("skips leading blank lines to the first line with words", () => {
    expect(deriveTitleFromBody("\n\n  Second attempt at this  \nmore")).toBe(
      "Second attempt at this",
    );
  });

  it("strips leading/inline markdown so the seed reads as prose", () => {
    expect(deriveTitleFromBody("## Ship the **release** today")).toBe(
      "Ship the release today",
    );
    expect(deriveTitleFromBody("- [ ] buy `milk` and eggs")).toBe(
      "[ ] buy milk and eggs",
    );
    expect(deriveTitleFromBody("> quote the [docs](http://x) here")).toBe(
      "quote the docs here",
    );
  });

  it("collapses internal whitespace", () => {
    expect(deriveTitleFromBody("Fix   the\tlogin   button")).toBe(
      "Fix the login button",
    );
  });

  it("returns '' when the body has no words (caller discards an empty draft)", () => {
    expect(deriveTitleFromBody("")).toBe("");
    expect(deriveTitleFromBody("   \n\t\n  ")).toBe("");
  });

  it("honors an explicit maxWords", () => {
    expect(deriveTitleFromBody("one two three four", 2)).toBe("one two");
  });
});
