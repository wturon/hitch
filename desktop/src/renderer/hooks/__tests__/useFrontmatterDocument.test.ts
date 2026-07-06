// @vitest-environment jsdom
//
// Field-aware adoption (seed-then-upgrade auto-titling, task dialog). The user can
// edit only two fields through the UI — title and body — so an external write into
// a DIRTY editor is merged per field: the user's outstanding edits survive, while
// machine-owned frontmatter and untouched fields adopt the external value. The
// pure merge is exercised across the full {title edited?, body edited?} matrix;
// the hook tests pin the dirty-flag coherence and the "don't disturb the body
// editor" invariant.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  mergeFrontmatterUpdate,
  useFrontmatterDocument,
} from "../useFrontmatterDocument";
import { parseFrontmatter, splitFrontmatter } from "@/lib/frontmatter";

// A task-shaped doc: a title, a machine-owned key (chat-id), and a body.
function doc(opts: {
  title?: string;
  chatId?: string;
  body?: string;
}): string {
  const lines: string[] = [];
  if (opts.title !== undefined) lines.push(`title: ${opts.title}`);
  if (opts.chatId !== undefined) lines.push(`chat-id: ${opts.chatId}`);
  return `---\n${lines.join("\n")}\n---\n${opts.body ?? ""}`;
}

const fm = (content: string) => parseFrontmatter(content).frontmatter;
const bodyOf = (content: string) => splitFrontmatter(content).body;

describe("mergeFrontmatterUpdate", () => {
  it("adopts external title + body + machine key when the user edited nothing", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const external = doc({ title: "Generated", chatId: "b", body: "changed" });
    // (In the hook this branch is the clean-adopt path; the merge with local ===
    // synced still yields the external content.)
    const merged = mergeFrontmatterUpdate({ local: synced, synced, external });
    expect(fm(merged).title).toBe("Generated");
    expect(fm(merged)["chat-id"]).toBe("b");
    expect(bodyOf(merged)).toBe("changed");
  });

  it("keeps a locally-edited title over an external rename (user wins)", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const local = doc({ title: "My title", chatId: "a", body: "hi" });
    const external = doc({ title: "Generated", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({ local, synced, external });
    expect(fm(merged).title).toBe("My title"); // user's edit survives
    expect(fm(merged)["chat-id"]).toBe("b"); // machine key still adopts external
    expect(bodyOf(merged)).toBe("hi");
  });

  it("adopts an external rename while the body is locally dirty", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const local = doc({ title: "Seed", chatId: "a", body: "my body edit" });
    const external = doc({ title: "Generated", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({ local, synced, external });
    expect(fm(merged).title).toBe("Generated"); // title untouched → adopt external
    expect(bodyOf(merged)).toBe("my body edit"); // body edit survives
    expect(fm(merged)["chat-id"]).toBe("b");
  });

  it("keeps both local title and body when both were edited", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const local = doc({ title: "My title", chatId: "a", body: "my body" });
    const external = doc({ title: "Generated", chatId: "b", body: "external body" });
    const merged = mergeFrontmatterUpdate({ local, synced, external });
    expect(fm(merged).title).toBe("My title");
    expect(bodyOf(merged)).toBe("my body");
    expect(fm(merged)["chat-id"]).toBe("b"); // machine key always adopts external
  });

  it("takes a machine key even when the user is mid-edit (closes the clobber hole)", () => {
    // External adds a chat-id the user's dirty draft doesn't have — it must ride
    // through rather than being dropped on the eventual whole-doc save.
    const synced = doc({ title: "Seed", body: "hi" });
    const local = doc({ title: "Seed", body: "typing…" });
    const external = doc({ title: "Seed", chatId: "bound", body: "hi" });
    const merged = mergeFrontmatterUpdate({ local, synced, external });
    expect(fm(merged)["chat-id"]).toBe("bound");
    expect(bodyOf(merged)).toBe("typing…");
  });
});

describe("useFrontmatterDocument adoption", () => {
  it("adopts an external write wholesale when the editor is clean", () => {
    const { result, rerender } = renderHook(
      ({ content }) => useFrontmatterDocument(content),
      { initialProps: { content: doc({ title: "Seed", body: "hi" }) } },
    );
    rerender({ content: doc({ title: "Generated", chatId: "b", body: "hi" }) });
    expect(result.current.title).toBe("Generated");
    expect(result.current.frontmatter["chat-id"]).toBe("b");
    expect(result.current.dirty).toBe(false);
  });

  it("keeps the body byte-identical (editor not reset) when the body is dirty and external renames the title", () => {
    const { result, rerender } = renderHook(
      ({ content }) => useFrontmatterDocument(content),
      { initialProps: { content: doc({ title: "Seed", body: "hi" }) } },
    );
    act(() => result.current.setBody("my body edit"));
    const bodyBefore = result.current.body;
    rerender({ content: doc({ title: "Generated", chatId: "b", body: "hi" }) });
    expect(result.current.title).toBe("Generated"); // title adopted
    expect(result.current.body).toBe(bodyBefore); // body untouched → editor stable
    expect(result.current.dirty).toBe(true); // body edit still outstanding
  });

  it("keeps a user title rename over an external title write", () => {
    const { result, rerender } = renderHook(
      ({ content }) => useFrontmatterDocument(content),
      { initialProps: { content: doc({ title: "Seed", body: "hi" }) } },
    );
    act(() => result.current.setTitle("My title"));
    rerender({ content: doc({ title: "Generated", chatId: "b", body: "hi" }) });
    expect(result.current.title).toBe("My title");
    expect(result.current.frontmatter["chat-id"]).toBe("b");
    expect(result.current.dirty).toBe(true);
  });
});
