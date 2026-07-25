// Pure capture helpers: the sortOrder prepend, the seed title (deriveTitleFromBody
// + captureSeedTitle's "Untitled" fallback), and the body-verbatim normalization
// (CRLF only — capture text is sacred).
import { describe, expect, it } from "vitest";
import { generateKeyBetween } from "fractional-indexing";

import {
  captureSeedTitle,
  captureSortOrder,
  deriveTitleFromBody,
  normalizeCaptureBody,
} from "../capture";

// The capture flow's title mechanism. Invariant: capture text is sacred; the
// title is additive metadata derived NON-DESTRUCTIVELY from the body's first ~6
// words — the body itself is never mutated by deriving a title.
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

  it("returns '' when the body has no words", () => {
    expect(deriveTitleFromBody("")).toBe("");
    expect(deriveTitleFromBody("   \n\t\n  ")).toBe("");
  });

  it("honors an explicit maxWords", () => {
    expect(deriveTitleFromBody("one two three four", 2)).toBe("one two");
  });
});

describe("captureSortOrder", () => {
  it("mints the first key for an empty backlog", () => {
    expect(captureSortOrder([])).toBe(generateKeyBetween(null, null));
  });

  it("prepends BEFORE the current backlog head", () => {
    const key = captureSortOrder([{ sortOrder: "a1" }, { sortOrder: "a2" }]);
    // Fractional-index keys are plain ASCII: lexicographic order IS list
    // order (see todoGroups), so a plain string compare pins the prepend.
    expect(key < "a1").toBe(true);
  });

  it("keeps prepending as captures stack up (each new head sorts first)", () => {
    let backlog: { sortOrder: string }[] = [{ sortOrder: "a0" }];
    for (let i = 0; i < 3; i++) {
      const key = captureSortOrder(backlog);
      expect(key < backlog[0].sortOrder).toBe(true);
      backlog = [{ sortOrder: key }, ...backlog];
    }
  });
});

describe("captureSeedTitle", () => {
  it("is deriveTitleFromBody, reused — not a copy", () => {
    const body = "## Fix the **drag ghost** on the board\nmore detail";
    expect(captureSeedTitle(body)).toBe(deriveTitleFromBody(body));
  });

  it("falls back to Untitled when the body has no words", () => {
    // deriveTitleFromBody strips markdown marks, so a symbols-only body
    // derives to "" — but the server requires a non-empty title.
    expect(captureSeedTitle("***")).toBe("Untitled");
  });
});

describe("normalizeCaptureBody", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeCaptureBody("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("touches NOTHING else (body verbatim)", () => {
    const body = "  ## heading with spaces  \n\n- [ ] item\n\ttab\n";
    expect(normalizeCaptureBody(body)).toBe(body);
  });
});
