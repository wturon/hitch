import { describe, expect, it } from "vitest";

import { taskMarkdown } from "../taskMarkdown";

describe("taskMarkdown", () => {
  it("renders the title as an h1 above the body", () => {
    expect(
      taskMarkdown({
        title: "Copy task as markdown",
        body: "Add a Copy as markdown action.\n\nTwo entry points.",
      }),
    ).toBe(
      "# Copy task as markdown\n\nAdd a Copy as markdown action.\n\nTwo entry points.",
    );
  });

  it("carries no task id, link, or tags — the paste target can't use them", () => {
    const out = taskMarkdown({ title: "Ship it", body: "Body text." });
    expect(out).toBe("# Ship it\n\nBody text.");
  });

  it("leaves an empty body as a heading with no trailing blank line", () => {
    expect(taskMarkdown({ title: "Just a title", body: "" })).toBe(
      "# Just a title",
    );
    expect(taskMarkdown({ title: "Just a title", body: "\n\n  \n" })).toBe(
      "# Just a title",
    );
  });

  it("leaves an untitled task's body without an orphan heading", () => {
    expect(taskMarkdown({ title: "", body: "Only a body." })).toBe(
      "Only a body.",
    );
    expect(taskMarkdown({ title: "   ", body: "Only a body." })).toBe(
      "Only a body.",
    );
  });

  it("is empty for an empty task rather than emitting punctuation", () => {
    expect(taskMarkdown({ title: "", body: "" })).toBe("");
  });

  it("passes the body through verbatim, markdown and all", () => {
    const body = [
      "- [ ] one",
      "- [x] two",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "> quoted **bold** text with $VARS and `backticks`",
    ].join("\n");
    expect(taskMarkdown({ title: "T", body })).toBe(`# T\n\n${body}`);
  });

  it("does not demote a body that opens with its own heading", () => {
    // Two H1s is the accepted cost of never rewriting the user's text.
    expect(taskMarkdown({ title: "Outer", body: "# Inner\n\ntext" })).toBe(
      "# Outer\n\n# Inner\n\ntext",
    );
  });

  it("keeps interior whitespace while trimming the edges", () => {
    expect(
      taskMarkdown({ title: "  Padded  ", body: "\n\nfirst\n\n\nlast\n\n" }),
    ).toBe("# Padded\n\nfirst\n\n\nlast");
  });
});
