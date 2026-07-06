// @vitest-environment jsdom
//
// Regression for the single-binding bug (the reason this whole change exists):
// a capture-born saved card used to run forever on its own local draft, so the
// daemon's generated title (and any other external write) never reached the OPEN
// dialog until it was closed and reopened. After the fix, App keeps the SAME
// TodoBody mounted across the capture→edit commit and starts feeding it the live
// query row through useTaskDraft's `content` prop. This pins that binding at the
// hook level — the layer the harness supports — by replaying the exact prop
// sequence the dialog drives: a fresh capture (`content: ""`), the ⌘⏎ write
// (draft mutated to the persisted bytes), the commit (the live row arrives as
// `content`, a no-op merge that rebases the baseline), then the daemon's async
// title upgrade (`content` changes again). The dialog's header reads
// draft.frontmatter.title, so "the header updates" == that value tracking.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useTaskDraft } from "@/hooks/useTaskDraft";
import { shouldSaveOnClose } from "../useDiscardGuard";

// The bytes the ⌘⏎ transform writes (deriveTitleFromBody-style seed title +
// verbatim body) and the bytes the daemon writes back ~15s later with a better
// title. Body is byte-identical between the two — only the title changes.
const SEED = "---\ntitle: Buy milk and\n---\nBuy milk and eggs\nfor the cake";
const RENAMED =
  "---\ntitle: Grocery run for the cake\n---\nBuy milk and eggs\nfor the cake";

const titleOf = (r: { current: { frontmatter: Record<string, string> } }) =>
  r.current.frontmatter.title;
const bodyOf = (r: { current: { body: string } }) => r.current.body;

describe("capture→commit→external-title binding", () => {
  it("an external title update reaches the OPEN capture-born card (the reported bug)", () => {
    // 1. Fresh capture: the body-only draft opens empty.
    const { result, rerender } = renderHook(({ c }) => useTaskDraft(c), {
      initialProps: { c: "" },
    });
    expect(result.current.dirty).toBe(false);

    // 2. ⌘⏎ transform: the dialog derives a seed title + keeps the body verbatim,
    //    then writes the raw bytes. The draft holds exactly what was written.
    act(() => {
      result.current.setTitle("Buy milk and");
      result.current.setBody("Buy milk and eggs\nfor the cake");
    });
    expect(result.current.getLatestRaw()).toBe(SEED);

    // 3. Commit: App flips create→edit and the live row arrives as `content`.
    //    The bytes match what we just wrote → a no-op merge that rebases the
    //    dirty baseline. Same hook instance (no remount), so state is preserved.
    rerender({ c: SEED });
    expect(titleOf(result)).toBe("Buy milk and");
    expect(result.current.dirty).toBe(false);

    // 4. The daemon's async rename lands on the live row. THIS is what the old
    //    forked capture instance never saw. Now the still-mounted card adopts it.
    rerender({ c: RENAMED });
    expect(titleOf(result)).toBe("Grocery run for the cake");
    expect(bodyOf(result)).toBe("Buy milk and eggs\nfor the cake");
  });

  it("mid-arrival body edits survive while the title still adopts (dirty merge)", () => {
    const { result, rerender } = renderHook(({ c }) => useTaskDraft(c), {
      initialProps: { c: "" },
    });
    act(() => {
      result.current.setTitle("Buy milk and");
      result.current.setBody("Buy milk and eggs\nfor the cake");
    });
    rerender({ c: SEED }); // commit → clean baseline

    // The user keeps typing in the saved card BEFORE the rename arrives.
    act(() => {
      result.current.setBody("Buy milk and eggs\nfor the cake\nand candles");
    });
    expect(result.current.dirty).toBe(true);

    // The daemon rename arrives mid-edit: the machine-owned title adopts, the
    // user's outstanding body edit survives (field-aware merge).
    rerender({ c: RENAMED });
    expect(titleOf(result)).toBe("Grocery run for the cake");
    expect(bodyOf(result)).toBe(
      "Buy milk and eggs\nfor the cake\nand candles",
    );
  });

  it("claimed-title race: the kept seed is WRITTEN on close (gate fires despite matching our last write)", () => {
    // The PR #72 review's integration path, end to end at the hook + gate
    // level: seed written (lastWritten = SEED) → user FOCUSES the title (claim,
    // no edit) → daemon writes the generated title → the claimed merge keeps
    // the local seed, byte-identical to lastWritten — so the old
    // `latest !== lastWritten` close gate would SKIP the write and the
    // forfeited generation would survive on disk. shouldSaveOnClose must fire
    // off `dirty` (draft ≠ live row) instead.
    let claimed: readonly string[] = [];
    const { result, rerender } = renderHook(
      ({ c }) => useTaskDraft(c, { claimedKeys: () => claimed }),
      { initialProps: { c: "" } },
    );
    act(() => {
      result.current.setTitle("Buy milk and");
      result.current.setBody("Buy milk and eggs\nfor the cake");
    });
    rerender({ c: SEED }); // commit → clean baseline; the write set lastWritten = SEED
    const lastWritten = SEED;

    claimed = ["title"]; // the user focuses the title input (no edit)
    rerender({ c: RENAMED }); // the daemon's generated title lands on disk

    // The claim held: the draft still carries the seed title…
    expect(titleOf(result)).toBe("Buy milk and");
    // …which is byte-identical to our last write (the old gate's blind spot)…
    expect(result.current.getLatestRaw()).toBe(lastWritten);
    // …but dirty against the live row, so the close gate MUST write.
    expect(result.current.dirty).toBe(true);
    expect(
      shouldSaveOnClose({
        dirty: result.current.dirty,
        latest: result.current.getLatestRaw(),
        lastWritten,
      }),
    ).toBe(true);
  });

  it("unchanged existing todo still skips the close write (no-op close stays free)", () => {
    const { result } = renderHook(({ c }) => useTaskDraft(c), {
      initialProps: { c: SEED },
    });
    expect(
      shouldSaveOnClose({
        dirty: result.current.dirty,
        latest: result.current.getLatestRaw(),
        lastWritten: SEED, // an existing todo initializes lastWritten to its content
      }),
    ).toBe(false);
  });

  it("opening a DIFFERENT todo is a fresh seed (a new session remounts the hook)", () => {
    // A new session == a new React key == a remount, so useTaskDraft re-seeds
    // from the new row's content rather than carrying the prior draft. Model the
    // remount as a fresh renderHook (App's key change does exactly this).
    const first = renderHook(({ c }) => useTaskDraft(c), {
      initialProps: { c: SEED },
    });
    expect(titleOf(first.result)).toBe("Buy milk and");

    const OTHER = "---\ntitle: Ship the release\n---\nCut a tag, push it";
    const second = renderHook(({ c }) => useTaskDraft(c), {
      initialProps: { c: OTHER },
    });
    expect(titleOf(second.result)).toBe("Ship the release");
    expect(bodyOf(second.result)).toBe("Cut a tag, push it");
  });
});
