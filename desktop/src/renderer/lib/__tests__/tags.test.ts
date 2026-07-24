import { describe, expect, it } from "vitest";

import {
  nextRotationColor,
  TAG_COLOR_ROTATION,
  tagTint,
  toTagColor,
} from "../tagColors";
import { EMPTY_TAG_FILTER, isTagFilterActive } from "../tagFilter";
import { normalizeTag } from "../../components/tags/TagCombobox";
import { splitTagPills } from "../../components/tags/TagPill";

describe("normalizeTag — canonical tag id", () => {
  it("normalizes tokens to lowercase kebab", () => {
    expect(normalizeTag("Bug")).toBe("bug");
    expect(normalizeTag("Needs Design")).toBe("needs-design");
    expect(normalizeTag("  API v2 ")).toBe("api-v2");
    expect(normalizeTag("--weird__value--")).toBe("weird-value");
    expect(normalizeTag("!!!")).toBe("");
  });
});

describe("tagColors — palette + rotation", () => {
  it("unknown color names fall back to gray", () => {
    expect(toTagColor(undefined)).toBe("gray");
    expect(toTagColor("chartreuse")).toBe("gray");
    expect(toTagColor("green")).toBe("green");
    // A tag with no registry entry renders gray.
    expect(tagTint("nope")).toEqual(tagTint("gray"));
  });

  it("rotates colors by existing count (gray sits last)", () => {
    expect(nextRotationColor(0)).toBe(TAG_COLOR_ROTATION[0]);
    expect(nextRotationColor(TAG_COLOR_ROTATION.length)).toBe(
      TAG_COLOR_ROTATION[0],
    );
    expect(nextRotationColor(1)).toBe(TAG_COLOR_ROTATION[1]);
  });
});

describe("tagFilter — active-state primitive", () => {
  it("EMPTY_TAG_FILTER is inactive; any selection or untagged is active", () => {
    expect(isTagFilterActive(EMPTY_TAG_FILTER)).toBe(false);
    expect(isTagFilterActive({ tags: ["a"], untagged: false })).toBe(true);
    expect(isTagFilterActive({ tags: [], untagged: true })).toBe(true);
  });
});

describe("TagPillGroup — +N overflow split", () => {
  it("shows first 3 and overflows the rest", () => {
    expect(splitTagPills(["a", "b"])).toEqual({ shown: ["a", "b"], overflow: 0 });
    expect(splitTagPills(["a", "b", "c"])).toEqual({
      shown: ["a", "b", "c"],
      overflow: 0,
    });
    expect(splitTagPills(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "b", "c"],
      overflow: 2,
    });
  });
});
