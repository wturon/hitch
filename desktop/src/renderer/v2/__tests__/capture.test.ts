// Pure capture helpers: the sortOrder prepend, the seed title (V1's
// deriveTitleFromBody, IMPORTED — this suite pins that reuse), and the
// body-verbatim normalization (CRLF only — capture text is sacred).
import { describe, expect, it } from "vitest";
import { generateKeyBetween } from "fractional-indexing";

import { deriveTitleFromBody } from "@/lib/tasks";
import {
  captureSeedTitle,
  captureSortOrder,
  normalizeCaptureBody,
} from "../capture";

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
