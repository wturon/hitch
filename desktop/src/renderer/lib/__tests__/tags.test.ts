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
import {
  deriveTodoGroups,
  EMPTY_TAG_FILTER,
  filterTodoGroups,
  isTagFilterActive,
  tagFacetCounts,
  todoMatchesTagFilter,
  type FileRow,
} from "../todos";
import { splitTagPills } from "../../components/tags/TagPill";

// Build a task FileRow with the given frontmatter keys (undefined keys omitted).
function task(
  slug: string,
  fm: Record<string, string | undefined>,
  opts: { updatedAt?: number } = {},
): FileRow {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return {
    path: `tasks/${slug}/task.md`,
    content: `---\n${lines.join("\n")}\n---\n`,
    updatedAt: opts.updatedAt ?? 0,
  };
}

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

describe("todos — tag parsing on the row model", () => {
  it("parses frontmatter tags onto each todo", () => {
    const g = deriveTodoGroups([task("a", { tags: "Easy, bug" })], []);
    expect(g.backlog[0].tags).toEqual(["easy", "bug"]);
  });

  it("absent key → untagged", () => {
    const g = deriveTodoGroups([task("a", { title: "x" })], []);
    expect(g.backlog[0].tags).toEqual([]);
  });

  it("config.json is not a task (never appears as a todo)", () => {
    const files: FileRow[] = [
      task("a", { tags: "bug" }),
      { path: "tasks/config.json", content: "{}", updatedAt: 0 },
    ];
    const g = deriveTodoGroups(files, []);
    expect(g.backlog).toHaveLength(1);
    expect(g.backlog[0].slug).toBe("a");
  });
});

describe("todos — AND filter + Untagged exclusivity", () => {
  const todo = (tags: string[]) => ({ tags }) as never;

  it("AND semantics: a row must carry every selected tag", () => {
    expect(
      todoMatchesTagFilter(todo(["a", "b"]), { tags: ["a", "b"], untagged: false }),
    ).toBe(true);
    expect(
      todoMatchesTagFilter(todo(["a"]), { tags: ["a", "b"], untagged: false }),
    ).toBe(false);
    expect(
      todoMatchesTagFilter(todo([]), { tags: [], untagged: false }),
    ).toBe(true); // inactive filter matches all
  });

  it("Untagged matches only tag-less rows", () => {
    expect(todoMatchesTagFilter(todo([]), { tags: [], untagged: true })).toBe(
      true,
    );
    expect(todoMatchesTagFilter(todo(["a"]), { tags: [], untagged: true })).toBe(
      false,
    );
  });

  it("filterTodoGroups empties non-matching groups (empty-group hiding)", () => {
    const files = [
      task("n", { "chat-harness": "claude-code", "chat-id": "1", tags: "bug" }), // needs-you
      task("b1", { tags: "bug" }), // backlog, matches
      task("b2", { tags: "easy" }), // backlog, no match
      task("d", { "completed-at": "2026-01-01", tags: "easy" }), // done, no match
    ];
    const all = deriveTodoGroups(files, []);
    const filtered = filterTodoGroups(all, { tags: ["bug"], untagged: false });
    expect(filtered.needsYou).toHaveLength(1);
    expect(filtered.backlog.map((t) => t.slug)).toEqual(["b1"]);
    expect(filtered.done).toHaveLength(0); // group emptied → view hides it
  });

  it("inactive filter returns the same groups object (no work)", () => {
    const all = deriveTodoGroups([task("a", { tags: "bug" })], []);
    expect(filterTodoGroups(all, EMPTY_TAG_FILTER)).toBe(all);
    expect(isTagFilterActive(EMPTY_TAG_FILTER)).toBe(false);
    expect(isTagFilterActive({ tags: ["a"], untagged: false })).toBe(true);
    expect(isTagFilterActive({ tags: [], untagged: true })).toBe(true);
  });
});

describe("todos — facet counts", () => {
  const universe = deriveTodoGroups(
    [
      task("t1", { tags: "bug, easy" }),
      task("t2", { tags: "bug" }),
      task("t3", { tags: "easy" }),
      task("t4", { title: "untagged-one" }),
    ],
    [],
  );
  const todos = [
    ...universe.needsYou,
    ...universe.working,
    ...universe.backlog,
    ...universe.done,
  ];

  it("no selection → count is how many carry each tag", () => {
    const { byTag, untagged } = tagFacetCounts(todos, EMPTY_TAG_FILTER);
    expect(byTag.get("bug")).toBe(2);
    expect(byTag.get("easy")).toBe(2);
    expect(untagged).toBe(1);
  });

  it("with a selection → count is the AND-match if that tag were added", () => {
    const { byTag } = tagFacetCounts(todos, { tags: ["bug"], untagged: false });
    // bug already selected → current match count (2).
    expect(byTag.get("bug")).toBe(2);
    // adding easy to {bug} → only t1 has both.
    expect(byTag.get("easy")).toBe(1);
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
