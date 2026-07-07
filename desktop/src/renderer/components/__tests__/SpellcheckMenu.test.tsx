// @vitest-environment jsdom
//
// SpellcheckMenu: the app-styled replacement for the native spellcheck context
// menu. It's driven by the main process pushing a payload over the preload bridge
// (window.hitchDaemon.onSpellcheckMenu), so we stub that bridge, fire a payload,
// and assert the menu renders + its actions call back through the bridge. We also
// assert the shared store flips open (which is what makes the format toolbar yield).
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpellcheckMenu } from "../SpellcheckMenu";
import { spellcheckMenuStore } from "@/editor/spellcheckMenuStore";

let emit: ((payload: unknown) => void) | null = null;
const replaceMisspelling = vi.fn(() => Promise.resolve());
const addWordToDictionary = vi.fn(() => Promise.resolve());

beforeEach(() => {
  emit = null;
  replaceMisspelling.mockClear();
  addWordToDictionary.mockClear();
  (window as unknown as { hitchDaemon: unknown }).hitchDaemon = {
    replaceMisspelling,
    addWordToDictionary,
    onSpellcheckMenu: (cb: (p: unknown) => void) => {
      emit = cb;
      return () => {
        emit = null;
      };
    },
  };
});

afterEach(() => {
  cleanup();
  spellcheckMenuStore.setOpen(false);
});

const menu = () => document.querySelector('[aria-label="Spelling suggestions"]');
const items = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (n) => n.textContent,
  );

async function show(payload: {
  word: string;
  suggestions: string[];
  x?: number;
  y?: number;
}) {
  await act(async () => {
    emit?.({ x: 20, y: 20, ...payload });
  });
}

describe("SpellcheckMenu", () => {
  it("renders suggestions from the pushed payload and marks the store open", async () => {
    render(<SpellcheckMenu />);
    expect(menu()).toBeNull();
    expect(spellcheckMenuStore.isOpen()).toBe(false);

    await show({ word: "camra", suggestions: ["camera", "Camry"] });

    expect(menu()).not.toBeNull();
    expect(items()).toEqual(["camera", "Camry", "Add to Dictionary"]);
    expect(spellcheckMenuStore.isOpen()).toBe(true);
  });

  it("clicking a suggestion replaces the word and closes", async () => {
    render(<SpellcheckMenu />);
    await show({ word: "camra", suggestions: ["camera", "Camry"] });

    const camera = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((n) => n.textContent === "camera")!;
    await act(async () => {
      fireEvent.mouseDown(camera);
      fireEvent.click(camera);
    });

    expect(replaceMisspelling).toHaveBeenCalledWith("camera");
    expect(menu()).toBeNull();
    expect(spellcheckMenuStore.isOpen()).toBe(false);
  });

  it("Add to Dictionary teaches the word and closes", async () => {
    render(<SpellcheckMenu />);
    await show({ word: "camra", suggestions: [] });

    // No suggestions → still shows the dictionary action.
    expect(items()).toEqual(["Add to Dictionary"]);
    const add = document.querySelector('[role="menuitem"]')!;
    await act(async () => {
      fireEvent.mouseDown(add);
      fireEvent.click(add);
    });

    expect(addWordToDictionary).toHaveBeenCalledWith("camra");
    expect(menu()).toBeNull();
  });

  it("Escape closes and clears the store flag", async () => {
    render(<SpellcheckMenu />);
    await show({ word: "camra", suggestions: ["camera"] });
    expect(menu()).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(menu()).toBeNull();
    expect(spellcheckMenuStore.isOpen()).toBe(false);
  });
});
