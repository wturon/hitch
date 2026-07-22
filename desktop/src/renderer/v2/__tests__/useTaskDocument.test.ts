// @vitest-environment jsdom
//
// The V2 document hook: per-field dirty tracking over {title, body} row
// fields. The matrix under test is the single-binding contract — adopt
// external values into CLEAN fields, keep local values in DIRTY fields (a
// byte-compare, so our own save echoing back through a refetch never touches
// the editor), rebase-don't-adopt on the FIRST row arrival (capture commit),
// and flush() PATCHing only the dirty fields.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  useTaskDocument,
  type TaskDocumentFields,
} from "../useTaskDocument";

type HookProps = {
  row: TaskDocumentFields | undefined;
  initial?: TaskDocumentFields;
  persist: (patch: Partial<TaskDocumentFields>) => Promise<void>;
};

function mount(props: HookProps) {
  return renderHook((p: HookProps) => useTaskDocument(p), {
    initialProps: props,
  });
}

const row = (title: string, body: string): TaskDocumentFields => ({ title, body });

describe("useTaskDocument", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("seeds from the row in edit mode and starts clean", () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({ row: row("T", "B"), persist });
    expect(result.current.title).toBe("T");
    expect(result.current.body).toBe("B");
    expect(result.current.dirty).toBe(false);
  });

  it("tracks dirtiness per field and flushes ONLY the dirty fields", async () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("B edited"));
    expect(result.current.dirty).toBe(true);
    await act(() => result.current.flush());
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ body: "B edited" }); // no title key
  });

  it("flush is a no-op when clean", async () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({ row: row("T", "B"), persist });
    await act(() => result.current.flush());
    expect(persist).not.toHaveBeenCalled();
  });

  it("adopts an external change into a CLEAN field while a dirty sibling keeps local", () => {
    // The echo-suppression e2e scenario: body dirty mid-type, an out-of-band
    // PATCH renames the title. The title (clean) adopts; the body (dirty)
    // must stay byte-identical so the editor is not reset.
    const persist = vi.fn(async () => {});
    const { result, rerender } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("B typing"));
    rerender({ row: row("Renamed via API", "B"), persist });
    expect(result.current.title).toBe("Renamed via API");
    expect(result.current.body).toBe("B typing");
    expect(result.current.dirty).toBe(true); // body still unsaved
  });

  it("keeps a DIRTY field's local value when external moves it elsewhere", () => {
    const persist = vi.fn(async () => {});
    const { result, rerender } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("mine"));
    rerender({ row: row("T", "theirs"), persist });
    expect(result.current.body).toBe("mine");
    expect(result.current.dirty).toBe(true); // still diverges from the row
  });

  it("treats our own echo as clean via byte-compare (no value change, dirty clears)", () => {
    const persist = vi.fn(async () => {});
    const { result, rerender } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("B saved"));
    // The autosave PATCH landed and the refetch brought our bytes back.
    rerender({ row: row("T", "B saved"), persist });
    expect(result.current.body).toBe("B saved"); // untouched
    expect(result.current.dirty).toBe(false); // rebased clean
  });

  it("debounces the autosave ~1.5s after the LAST edit", async () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("one"));
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.setBody("two")); // resets the timer
    act(() => vi.advanceTimersByTime(1000));
    expect(persist).not.toHaveBeenCalled(); // only 1s since the last edit
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ body: "two" });
  });

  it("flush cancels the pending autosave (no double save)", async () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("edited"));
    await act(() => result.current.flush());
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("uncommitted (capture): no autosave, flush no-ops, initial seeds the draft", async () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({
      row: undefined,
      initial: row("", "recovered draft"),
      persist,
    });
    expect(result.current.body).toBe("recovered draft");
    expect(result.current.dirty).toBe(false); // nothing to be dirty against
    act(() => result.current.setBody("typed more"));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(() => result.current.flush());
    expect(persist).not.toHaveBeenCalled();
  });

  it("first row arrival is a pure rebase: local kept verbatim, clean when it matches", () => {
    const persist = vi.fn(async () => {});
    const { result, rerender } = mount({ row: undefined, persist });
    act(() => {
      result.current.setTitle("Seed");
      result.current.setBody("captured");
    });
    // The capture committed; the live row resolves with the posted bytes.
    rerender({ row: row("Seed", "captured"), persist });
    expect(result.current.body).toBe("captured");
    expect(result.current.dirty).toBe(false);
  });

  it("keystrokes during the POST flight survive the first arrival and autosave after", async () => {
    const persist = vi.fn(async () => {});
    const { result, rerender } = mount({ row: undefined, persist });
    act(() => {
      result.current.setTitle("Seed");
      result.current.setBody("captured plus more");
    });
    // The row arrives with only what was posted — local is AHEAD of it.
    rerender({ row: row("Seed", "captured"), persist });
    expect(result.current.body).toBe("captured plus more"); // never clobbered
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1600); // the arrival scheduled the catch-up save
    });
    expect(persist).toHaveBeenCalledWith({ body: "captured plus more" });
  });

  it("setTitle strips newlines (single-line field)", () => {
    const persist = vi.fn(async () => {});
    const { result } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setTitle("a\r\nb\nc"));
    expect(result.current.title).toBe("a b c");
  });

  it("a failed flush leaves the fields dirty so a later flush retries", async () => {
    const persist = vi
      .fn<(patch: Partial<TaskDocumentFields>) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { result } = mount({ row: row("T", "B"), persist });
    act(() => result.current.setBody("edited"));
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow("offline");
    });
    expect(result.current.dirty).toBe(true);
    await act(() => result.current.flush());
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({ body: "edited" });
  });
});
