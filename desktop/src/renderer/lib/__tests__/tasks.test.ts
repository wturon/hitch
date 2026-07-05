import { describe, expect, it } from "vitest";

import { splitCaptureText } from "../tasks";

// Todos v1, Decision 2 (title/body split — "Option B, split once at ⌘⏎"). These
// are the pure half of the two-stage create's crystallize moment: the stage-1
// capture text is split into the independent `title:` frontmatter + the body.
// Test matrix rows 4 (multi-line), 5 (one-liner), 6 (>~120-char first line).
describe("splitCaptureText", () => {
  it("row 5 — one-liner: title only, empty body", () => {
    expect(splitCaptureText("Fix the drag ghost")).toEqual({
      title: "Fix the drag ghost",
      body: "",
    });
  });

  it("row 4 — multi-line: first line → title, remainder → body", () => {
    expect(
      splitCaptureText(
        "Fix the drag ghost when reordering backlog rows\nIt flickers when the row crosses a group boundary.",
      ),
    ).toEqual({
      title: "Fix the drag ghost when reordering backlog rows",
      body: "It flickers when the row crosses a group boundary.",
    });
  });

  it("row 4 — preserves multi-paragraph body verbatim (incl. blank lines)", () => {
    const { title, body } = splitCaptureText(
      "Title line\n\nParagraph one.\n\nParagraph two.",
    );
    expect(title).toBe("Title line");
    expect(body).toBe("\nParagraph one.\n\nParagraph two.");
  });

  it("normalizes CRLF to LF at the split point", () => {
    expect(splitCaptureText("Title\r\nBody line")).toEqual({
      title: "Title",
      body: "Body line",
    });
  });

  it("trims the title's own outer whitespace but keeps the body", () => {
    expect(splitCaptureText("   Padded title   \n  body stays  ")).toEqual({
      title: "Padded title",
      body: "  body stays  ",
    });
  });

  it("row 6 — run-on first line caps near 120 at a word boundary; overflow → body", () => {
    const runOn =
      "This is a deliberately long single first line that keeps going well past the one hundred and twenty character soft cap without any newline break at all";
    const { title, body } = splitCaptureText(runOn);
    expect(title.length).toBeLessThanOrEqual(120);
    // Broke on a space (no word sliced), so title + " " + body reconstructs it.
    expect(title.endsWith(" ")).toBe(false);
    expect(`${title} ${body}`).toBe(runOn);
    // The break landed on a real word boundary within the cap.
    expect(runOn.startsWith(title)).toBe(true);
    expect(runOn[title.length]).toBe(" ");
  });

  it("row 6 — run-on first line with later lines: overflow rejoins ahead of the rest", () => {
    const first =
      "Averyverylongunbrokentokenwithnospacesatallthatexceedsthecapandhasnowordboundarytobreakonsoitgetsahardcutrightatthelimitxx";
    expect(first.length).toBeGreaterThan(120);
    const { title, body } = splitCaptureText(`${first}\nsecond line`);
    // No word boundary in reach → hard cut at exactly the cap.
    expect(title).toBe(first.slice(0, 120));
    expect(body).toBe(`${first.slice(120)}\nsecond line`);
  });

  it("empty / whitespace-only capture yields empty title and body", () => {
    expect(splitCaptureText("")).toEqual({ title: "", body: "" });
    expect(splitCaptureText("   ")).toEqual({ title: "", body: "" });
  });
});
