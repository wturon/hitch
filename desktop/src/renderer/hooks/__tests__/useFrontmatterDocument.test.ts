// @vitest-environment jsdom
//
// Field-aware adoption (seed-then-upgrade auto-titling). Callers declare which
// frontmatter keys their UI lets the user edit (tasks: ["title"]; notes:
// ["title", "type"]); the body is always user-owned. An external write into a
// DIRTY editor is merged per field: the user's outstanding edits to declared keys
// survive, machine-owned frontmatter and untouched fields adopt the external
// value. The pure merge is exercised across the {edited?} × {external changed?}
// matrix for both key sets; the hook tests pin the dirty-flag coherence and the
// "don't disturb the body editor" invariant.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  mergeFrontmatterUpdate,
  useFrontmatterDocument,
} from "../useFrontmatterDocument";
import { parseFrontmatter, splitFrontmatter } from "@/lib/frontmatter";

// A doc with the fields exercised here: user-ownable title / (notes) type, a
// machine-owned key (chat-id), and a body.
function doc(opts: {
  title?: string;
  type?: string;
  chatId?: string;
  tags?: string;
  body?: string;
}): string {
  const lines: string[] = [];
  if (opts.title !== undefined) lines.push(`title: ${opts.title}`);
  if (opts.type !== undefined) lines.push(`type: ${opts.type}`);
  if (opts.chatId !== undefined) lines.push(`chat-id: ${opts.chatId}`);
  if (opts.tags !== undefined) lines.push(`tags: ${opts.tags}`);
  return `---\n${lines.join("\n")}\n---\n${opts.body ?? ""}`;
}

const fm = (content: string) => parseFrontmatter(content).frontmatter;
const bodyOf = (content: string) => splitFrontmatter(content).body;

// The key sets the real callers declare: useTaskDraft and NotesView's NoteEditor.
// Tasks own title + tags (the dialog's tag lane edits tags in place).
const TASK_KEYS = ["title", "tags"] as const;
const NOTE_KEYS = ["title", "type"] as const;

describe("mergeFrontmatterUpdate (tasks: title user-owned)", () => {
  it("adopts external title + body + machine key when the user edited nothing", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const external = doc({ title: "Generated", chatId: "b", body: "changed" });
    // (In the hook this branch is the clean-adopt path; the merge with local ===
    // synced still yields the external content.)
    const merged = mergeFrontmatterUpdate({
      local: synced,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).title).toBe("Generated");
    expect(fm(merged)["chat-id"]).toBe("b");
    expect(bodyOf(merged)).toBe("changed");
  });

  it("keeps a locally-edited title over an external rename (user wins)", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const local = doc({ title: "My title", chatId: "a", body: "hi" });
    const external = doc({ title: "Generated", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).title).toBe("My title"); // user's edit survives
    expect(fm(merged)["chat-id"]).toBe("b"); // machine key still adopts external
    expect(bodyOf(merged)).toBe("hi");
  });

  it("adopts an external rename while the body is locally dirty", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const local = doc({ title: "Seed", chatId: "a", body: "my body edit" });
    const external = doc({ title: "Generated", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).title).toBe("Generated"); // title untouched → adopt external
    expect(bodyOf(merged)).toBe("my body edit"); // body edit survives
    expect(fm(merged)["chat-id"]).toBe("b");
  });

  it("keeps both local title and body when both were edited", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const local = doc({ title: "My title", chatId: "a", body: "my body" });
    const external = doc({ title: "Generated", chatId: "b", body: "external body" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).title).toBe("My title");
    expect(bodyOf(merged)).toBe("my body");
    expect(fm(merged)["chat-id"]).toBe("b"); // machine key always adopts external
  });

  it("keeps a locally-edited tag set while an external machine key rides through", () => {
    // The dialog's tag lane just added `urgent` locally; before that write echoes
    // back, the daemon binds a chat (a machine-key update). The tag edit is
    // in-flight and must survive the merge, while chat-id still adopts external.
    const synced = doc({ title: "T", tags: "[design]", body: "hi" });
    const local = doc({ title: "T", tags: "[design, urgent]", body: "hi" });
    const external = doc({ title: "T", tags: "[design]", chatId: "bound", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).tags).toBe("[design, urgent]"); // local tag edit survives
    expect(fm(merged)["chat-id"]).toBe("bound"); // machine key still adopts external
  });

  it("adopts an external tag change when the user hasn't touched tags", () => {
    // An agent edits the task's tags on disk while the clean dialog is open — no
    // local tag edit, so the external set is adopted wholesale (no stale fork).
    const synced = doc({ title: "T", tags: "[design]", body: "hi" });
    const external = doc({ title: "T", tags: "[design, shipped]", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local: synced,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).tags).toBe("[design, shipped]");
  });

  it("takes a machine key even when the user is mid-edit (closes the clobber hole)", () => {
    // External adds a chat-id the user's dirty draft doesn't have — it must ride
    // through rather than being dropped on the eventual whole-doc save.
    const synced = doc({ title: "Seed", body: "hi" });
    const local = doc({ title: "Seed", body: "typing…" });
    const external = doc({ title: "Seed", chatId: "bound", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged)["chat-id"]).toBe("bound");
    expect(bodyOf(merged)).toBe("typing…");
  });

  it("keeps a CLAIMED title local even when untouched (focus forfeits generation)", () => {
    // The user focused the title input but hasn't typed: local === synced for
    // title, but the claim splices the LOCAL value anyway — the daemon's
    // generated title is never adopted. Machine keys still ride through.
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const external = doc({ title: "Generated", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local: synced,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
      claimedKeys: ["title"],
    });
    expect(fm(merged).title).toBe("Seed"); // local survives despite no edit
    expect(fm(merged)["chat-id"]).toBe("b"); // machine key still adopts external
    expect(bodyOf(merged)).toBe("hi");
  });

  it("adopts the external title when unclaimed and untouched (existing behavior intact)", () => {
    const synced = doc({ title: "Seed", chatId: "a", body: "hi" });
    const external = doc({ title: "Generated", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local: synced,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
      claimedKeys: [],
    });
    expect(fm(merged).title).toBe("Generated");
    expect(fm(merged)["chat-id"]).toBe("b");
  });

  it("treats an UNDECLARED key as machine-owned even when locally edited", () => {
    // A task declares only `title`, so a local `type` edit (impossible through
    // the task UI, but the contract must hold) is NOT protected — external wins.
    const synced = doc({ title: "Seed", type: "note", body: "hi" });
    const local = doc({ title: "Seed", type: "user-set", body: "hi" });
    const external = doc({ title: "Seed", type: "machine-set", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: TASK_KEYS,
    });
    expect(fm(merged).type).toBe("machine-set");
  });
});

describe("mergeFrontmatterUpdate (notes: title + type user-owned)", () => {
  it("keeps a dirty type edit while an external machine-key stamp adopts (reviewer's scenario)", () => {
    // The user flips the note's type pill while the doc is dirty; an external
    // writer (e.g. the daemon binding a chat) stamps machine frontmatter. The
    // user's type must survive AND the machine key must ride through.
    const synced = doc({ title: "Note", type: "note", body: "hi" });
    const local = doc({ title: "Note", type: "decision", body: "hi" });
    const external = doc({ title: "Note", type: "note", chatId: "bound", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: NOTE_KEYS,
    });
    expect(fm(merged).type).toBe("decision"); // user's type edit survives
    expect(fm(merged)["chat-id"]).toBe("bound"); // machine key adopts
    expect(bodyOf(merged)).toBe("hi");
  });

  it("adopts an external type change when the user left type untouched (the inverse)", () => {
    const synced = doc({ title: "Note", type: "note", body: "hi" });
    const local = doc({ title: "Note", type: "note", body: "my edit" });
    const external = doc({ title: "Note", type: "decision", chatId: "b", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: NOTE_KEYS,
    });
    expect(fm(merged).type).toBe("decision"); // untouched → external wins
    expect(bodyOf(merged)).toBe("my edit"); // body edit survives
    expect(fm(merged)["chat-id"]).toBe("b");
  });

  it("keeps independent title and type edits separately", () => {
    // Title edited, type untouched: local title + external type, and vice versa
    // never bleed into each other.
    const synced = doc({ title: "Note", type: "note", body: "hi" });
    const local = doc({ title: "My note", type: "note", body: "hi" });
    const external = doc({ title: "Note", type: "decision", body: "hi" });
    const merged = mergeFrontmatterUpdate({
      local,
      synced,
      external,
      userOwnedKeys: NOTE_KEYS,
    });
    expect(fm(merged).title).toBe("My note");
    expect(fm(merged).type).toBe("decision");
  });
});

describe("useFrontmatterDocument adoption", () => {
  it("adopts an external write wholesale when the editor is clean", () => {
    const { result, rerender } = renderHook(
      ({ content }) =>
        useFrontmatterDocument(content, { userOwnedKeys: ["title"] }),
      { initialProps: { content: doc({ title: "Seed", body: "hi" }) } },
    );
    rerender({ content: doc({ title: "Generated", chatId: "b", body: "hi" }) });
    expect(result.current.title).toBe("Generated");
    expect(result.current.frontmatter["chat-id"]).toBe("b");
    expect(result.current.dirty).toBe(false);
  });

  it("keeps the body byte-identical (editor not reset) when the body is dirty and external renames the title", () => {
    const { result, rerender } = renderHook(
      ({ content }) =>
        useFrontmatterDocument(content, { userOwnedKeys: ["title"] }),
      { initialProps: { content: doc({ title: "Seed", body: "hi" }) } },
    );
    act(() => result.current.setBody("my body edit"));
    const bodyBefore = result.current.body;
    rerender({ content: doc({ title: "Generated", chatId: "b", body: "hi" }) });
    expect(result.current.title).toBe("Generated"); // title adopted
    expect(result.current.body).toBe(bodyBefore); // body untouched → editor stable
    expect(result.current.dirty).toBe(true); // body edit still outstanding
  });

  it("keeps a user title rename over an external title write (default keys)", () => {
    // No options: the hook defaults to protecting `title` (its own setTitle field).
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

  it("does NOT adopt an external title into a CLEAN draft when the title is claimed", () => {
    // The wholesale-adopt bypass is closed: a clean draft with a claimed title
    // must go through the merge, keeping the local (seed) title while machine
    // keys still adopt. This is the focused-but-untouched race: the daemon's
    // generated title must not swap the text under the user's cursor.
    let claimed: readonly string[] = [];
    const { result, rerender } = renderHook(
      ({ content }) =>
        useFrontmatterDocument(content, {
          userOwnedKeys: ["title"],
          claimedKeys: () => claimed,
        }),
      { initialProps: { content: doc({ title: "Seed", body: "hi" }) } },
    );
    claimed = ["title"]; // the user focuses the title input (no edit yet)
    rerender({ content: doc({ title: "Generated", chatId: "b", body: "hi" }) });
    expect(result.current.title).toBe("Seed"); // generation forfeits
    expect(result.current.frontmatter["chat-id"]).toBe("b"); // machine key adopts
    expect(result.current.dirty).toBe(true); // close-time save restores the seed on disk
  });

  it("keeps a note's dirty type edit through an external machine-key stamp", () => {
    // Hook-level regression for the reviewer's scenario, with NotesView's keys.
    const { result, rerender } = renderHook(
      ({ content }) =>
        useFrontmatterDocument(content, { userOwnedKeys: ["title", "type"] }),
      {
        initialProps: {
          content: doc({ title: "Note", type: "note", body: "hi" }),
        },
      },
    );
    act(() => result.current.setFrontmatter({ type: "decision" }));
    rerender({
      content: doc({ title: "Note", type: "note", chatId: "bound", body: "hi" }),
    });
    expect(result.current.frontmatter.type).toBe("decision"); // edit survives
    expect(result.current.frontmatter["chat-id"]).toBe("bound"); // machine key adopts
    expect(result.current.dirty).toBe(true);
  });
});
