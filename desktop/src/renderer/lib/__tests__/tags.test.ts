import { describe, expect, it } from "vitest";

import {
  normalizeTag,
  parseTagsValue,
  serializeTagsValue,
  setFrontmatterKeys,
} from "../frontmatter";
import {
  nextRotationColor,
  TAG_COLOR_ROTATION,
  tagTint,
  toTagColor,
} from "../tagColors";
import {
  ensureRegistryTag,
  parseTagRegistry,
  registryColorMap,
  serializeTagRegistry,
} from "../tagRegistry";
import { EMPTY_TAG_FILTER, isTagFilterActive } from "../tagFilter";
import { splitTagPills } from "../../components/tags/TagPill";

describe("tag frontmatter helpers — parse / normalize / serialize", () => {
  it("normalizes tokens to lowercase kebab", () => {
    expect(normalizeTag("Bug")).toBe("bug");
    expect(normalizeTag("Needs Design")).toBe("needs-design");
    expect(normalizeTag("  API v2 ")).toBe("api-v2");
    expect(normalizeTag("--weird__value--")).toBe("weird-value");
    expect(normalizeTag("!!!")).toBe("");
  });

  it("parses the comma-delimited scalar, trimming/normalizing/de-duping", () => {
    expect(parseTagsValue("easy, bug")).toEqual(["easy", "bug"]);
    expect(parseTagsValue("Easy ,  BUG , easy")).toEqual(["easy", "bug"]);
    expect(parseTagsValue("")).toEqual([]);
    expect(parseTagsValue(undefined)).toEqual([]);
    expect(parseTagsValue(" , ,")).toEqual([]);
  });

  it("round-trips through serialize → parse", () => {
    expect(serializeTagsValue(["Easy", "bug", "easy"])).toBe("easy, bug");
    expect(serializeTagsValue([])).toBe("");
    expect(parseTagsValue(serializeTagsValue(["a", "B", "a-b"]))).toEqual([
      "a",
      "b",
      "a-b",
    ]);
  });

  it("empty tags drops the frontmatter key entirely (untagged = no key)", () => {
    const withTag = setFrontmatterKeys("---\ntitle: x\n---\nbody", {
      tags: serializeTagsValue(["bug"]),
    });
    expect(withTag).toContain("tags: bug");
    const cleared = setFrontmatterKeys(withTag, {
      tags: serializeTagsValue([]),
    });
    expect(cleared).not.toContain("tags:");
    expect(cleared).toContain("title: x");
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

describe("tagRegistry — parse / serialize / ensure", () => {
  it("parses tolerantly and normalizes ids + clamps unknown colors", () => {
    const reg = parseTagRegistry(
      JSON.stringify({
        version: 1,
        tags: [
          { id: "Easy", color: "green" },
          { id: "bug", color: "neon" },
          { id: "bug", color: "red" }, // dup id — first wins
          { id: "", color: "blue" }, // blank — dropped
          "garbage",
        ],
      }),
    );
    expect(reg.tags).toEqual([
      { id: "easy", color: "green" },
      { id: "bug", color: "gray" },
    ]);
  });

  it("degrades malformed/empty JSON to an empty registry", () => {
    expect(parseTagRegistry("not json").tags).toEqual([]);
    expect(parseTagRegistry("").tags).toEqual([]);
    expect(parseTagRegistry(undefined).tags).toEqual([]);
  });

  it("ensureRegistryTag appends with the next rotation color, idempotently", () => {
    const base = parseTagRegistry(undefined);
    const first = ensureRegistryTag(base, "Bug");
    expect(first.changed).toBe(true);
    expect(first.registry.tags).toEqual([
      { id: "bug", color: nextRotationColor(0) },
    ]);
    // Already present → no change, same object back.
    const again = ensureRegistryTag(first.registry, "bug");
    expect(again.changed).toBe(false);
    expect(again.registry).toBe(first.registry);
  });

  it("serialize → parse round-trips", () => {
    const reg = ensureRegistryTag(
      ensureRegistryTag(parseTagRegistry(undefined), "a").registry,
      "b",
    ).registry;
    expect(parseTagRegistry(serializeTagRegistry(reg))).toEqual(reg);
  });

  it("registryColorMap looks up colors, missing → caller-defined default", () => {
    const reg = parseTagRegistry(
      JSON.stringify({ version: 1, tags: [{ id: "a", color: "blue" }] }),
    );
    const map = registryColorMap(reg);
    expect(map.get("a")).toBe("blue");
    expect(map.get("z")).toBeUndefined();
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
