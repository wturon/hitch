// The "no matches" sentence for the cross-project All tasks list.
//
// It is the one piece of new pure logic in AllTasksView, and it exists because
// the tag filter is ANDed: two tags that each have plenty of tasks can intersect
// in zero, and a generic "no todos match this filter" reads as a broken list
// rather than as "you asked for the overlap". So the sentence names the tags and
// puts the conjunction in words.
import { describe, expect, it } from "vitest";

import { noMatchesMessage } from "../AllTasksView";

const withTags = (...tags: string[]) => ({ tags, untagged: false });

describe("noMatchesMessage", () => {
  it("names the single active tag", () => {
    expect(noMatchesMessage(withTags("today"))).toBe("Nothing is tagged today.");
  });

  it("says 'both' for two tags, so the AND is readable", () => {
    expect(noMatchesMessage(withTags("today", "blocked"))).toBe(
      "Nothing is tagged both today and blocked.",
    );
  });

  it("says 'all of' for three or more, and lists them", () => {
    expect(noMatchesMessage(withTags("today", "blocked", "review"))).toBe(
      "Nothing is tagged all of today, blocked and review.",
    );
    expect(noMatchesMessage(withTags("a", "b", "c", "d"))).toBe(
      "Nothing is tagged all of a, b, c and d.",
    );
  });

  it("keeps the tags in the order the user selected them", () => {
    expect(noMatchesMessage(withTags("zeta", "alpha"))).toBe(
      "Nothing is tagged both zeta and alpha.",
    );
  });

  it("uses tag names verbatim — they are the user's own words", () => {
    expect(noMatchesMessage(withTags("needs-design"))).toBe(
      "Nothing is tagged needs-design.",
    );
  });

  it("says the useful inverse for Untagged, not a restatement of the filter", () => {
    // Untagged is exclusive of tag selections (tagFilter.ts), so it never has
    // tags to name.
    expect(noMatchesMessage({ tags: [], untagged: true })).toBe(
      "Everything here carries at least one tag.",
    );
  });

  it("degrades to a plain sentence for the empty filter", () => {
    // Unreachable in the view (an inactive filter hides nothing), but the
    // function must not produce "Nothing is tagged ." if it is ever called.
    expect(noMatchesMessage({ tags: [], untagged: false })).toBe("Nothing here.");
  });
});
