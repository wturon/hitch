import { describe, expect, it } from "vitest";

import { formatTimestamp, renderTable, truncate } from "../format.js";

describe("truncate", () => {
  it("passes short text through", () => {
    expect(truncate("Fix the bug", 20)).toBe("Fix the bug");
  });

  it("collapses whitespace and newlines", () => {
    expect(truncate("a  b\nc", 20)).toBe("a b c");
  });

  it("cuts long text with an ellipsis at exactly max chars", () => {
    const out = truncate("x".repeat(30), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderTable", () => {
  it("aligns columns on the widest cell, two-space gutters", () => {
    const out = renderTable(
      ["ID", "TITLE"],
      [
        ["0198c2a4", "Fix flaky sync test"],
        ["0198c2ff", "Ship"],
      ],
    );
    expect(out).toBe(
      ["ID        TITLE", "0198c2a4  Fix flaky sync test", "0198c2ff  Ship"].join("\n"),
    );
  });

  it("never leaves trailing whitespace (last column unpadded)", () => {
    const out = renderTable(["A", "B"], [["x", "y"]]);
    for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
  });
});

describe("formatTimestamp", () => {
  it("renders yyyy-mm-dd hh:mm", () => {
    expect(formatTimestamp(new Date(2026, 6, 22, 14, 3).toISOString())).toBe("2026-07-22 14:03");
  });

  it("passes unparseable input through", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});
