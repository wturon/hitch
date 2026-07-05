// @vitest-environment jsdom
//
// The capture-stage recovery draft (Todos v1 Decision 4 amendment): esc closes
// the capture card instantly, so the typed body is stashed in localStorage per
// project instead of behind a double-esc guard. Pinned here as plain
// localStorage round-trips — no React needed.
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCaptureDraft,
  loadCaptureDraft,
  saveCaptureDraft,
} from "../captureDraft";
import type { Id } from "@convex/_generated/dataModel";

const projectA = "project-a" as Id<"projects">;
const projectB = "project-b" as Id<"projects">;

beforeEach(() => {
  window.localStorage.clear();
});

describe("captureDraft", () => {
  it("round-trips a saved draft", () => {
    saveCaptureDraft(projectA, "buy milk");
    expect(loadCaptureDraft(projectA)).toBe("buy milk");
  });

  it("keys drafts per project", () => {
    saveCaptureDraft(projectA, "a's draft");
    saveCaptureDraft(projectB, "b's draft");
    expect(loadCaptureDraft(projectA)).toBe("a's draft");
    expect(loadCaptureDraft(projectB)).toBe("b's draft");
  });

  it("returns null when nothing is saved", () => {
    expect(loadCaptureDraft(projectA)).toBeNull();
  });

  it("saving empty content clears any existing draft instead of writing one", () => {
    saveCaptureDraft(projectA, "something");
    saveCaptureDraft(projectA, "   ");
    expect(loadCaptureDraft(projectA)).toBeNull();
  });

  it("clearCaptureDraft removes a saved draft", () => {
    saveCaptureDraft(projectA, "buy milk");
    clearCaptureDraft(projectA);
    expect(loadCaptureDraft(projectA)).toBeNull();
  });

  it("ignores malformed JSON rather than throwing", () => {
    window.localStorage.setItem("hitch:todo-capture-draft:project-a", "{not json");
    expect(loadCaptureDraft(projectA)).toBeNull();
  });
});
