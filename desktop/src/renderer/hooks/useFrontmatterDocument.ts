"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseFrontmatter,
  setFrontmatterKeys,
  splitFrontmatter,
  type Frontmatter,
} from "@/lib/frontmatter";

// Read the frontmatter `title` WITHOUT trimming. The title input is controlled by
// this value, and `parseFrontmatter` trims — so a trailing space the user just
// typed would be stripped on the round-trip, making the spacebar look broken in
// the title. Reading the raw line (minus the single separator space) preserves it.
function rawTitle(content: string): string {
  const { frontmatterBlock } = splitFrontmatter(content);
  const match = frontmatterBlock.match(/^title:(.*)$/m);
  return match ? match[1].replace(/^ /, "") : "";
}

// Field-aware merge of an external write into a DIRTY draft. The user can only
// edit two fields through the UI — the frontmatter `title` and the body — so
// those are the only fields whose local edits we protect. Every OTHER frontmatter
// key is machine-owned (chat-*, completed-at, chat-request…) and is ALWAYS taken
// from the external write. That last part also closes a pre-existing hole: the
// old all-or-nothing guard skipped a dirty editor's update entirely, so the
// eventual whole-doc save on close clobbered any daemon frontmatter stamp landed
// meanwhile (e.g. a chat binding). Now those keys ride through untouched.
//
// For title and body: keep the local value when the user changed it from the
// last-synced baseline, else adopt the external value. The result is rebuilt from
// the EXTERNAL frontmatter with the chosen title spliced in and the chosen body
// appended — so machine keys stay current while the outstanding user edit(s)
// survive. Crucially, when the body was locally edited the chosen body IS the
// local body, byte-identical to the draft's current body, so the controlled
// MarkdownEditor's `value` prop doesn't change and the Lexical body editor is not
// reset out from under the typing user.
export function mergeFrontmatterUpdate(input: {
  local: string; // the current dirty draft
  synced: string; // the baseline the draft was last reconciled against
  external: string; // the incoming external content
}): string {
  const { local, synced, external } = input;

  const titleEdited = rawTitle(local) !== rawTitle(synced);
  const bodyEdited =
    splitFrontmatter(local).body !== splitFrontmatter(synced).body;

  const chosenTitle = titleEdited ? rawTitle(local) : rawTitle(external);
  const chosenBody = bodyEdited
    ? splitFrontmatter(local).body
    : splitFrontmatter(external).body;

  // Rebuild on the external frontmatter (machine keys always win); splice in the
  // chosen title in place, then swap the body for the chosen one.
  const withTitle = setFrontmatterKeys(external, { title: chosenTitle });
  const { frontmatterBlock } = splitFrontmatter(withTitle);
  return frontmatterBlock + chosenBody;
}

// The in-memory document model for a single open frontmatter markdown file. It
// owns ONLY the document: the whole-file draft (frontmatter + body), the views
// derived from it, the generic mutations that edit it, the dirty flag, and
// adoption of external writes. It deliberately knows nothing about persistence
// (Convex), any dialog's close policy, or the editor component.
//
// This is the primitive-agnostic core shared by tasks and notes. Task-only
// machinery (chat-* selectors, clearChat) layers on top in useTaskDraft.
//
// `content` is the live file text from the query. The hook is mounted fresh per
// document (the editor is keyed by path), so `useState(() => content)` is the
// correct initialization — there is no "document switched under us" case to
// handle here; a different document remounts the hook. Don't remove that key.
export interface FrontmatterDocument {
  // The whole-file draft (frontmatter + body), edited verbatim and written back
  // byte-for-byte. This is the canonical value.
  raw: string;
  // The latest `raw`, read synchronously from the internal ref. Use this instead
  // of the `raw` field inside async callbacks that span a mutation (e.g. an
  // attachment upload that first materializes a draft, changing the frontmatter):
  // the `raw` field is the render-time snapshot and would be stale.
  getLatestRaw: () => string;
  // The body half only — what the friendly editor sees. Frontmatter never enters
  // the formatted editor; it's recombined verbatim on every body edit.
  body: string;
  // The untrimmed frontmatter title (see `rawTitle`).
  title: string;
  frontmatter: Frontmatter;
  // True when the draft diverges from the live file content. Baseline is the
  // current `content` prop: a wholesale adopt (clean editor) resets it to clean; a
  // field-aware merge (dirty editor) leaves it dirty iff a user-edited field still
  // differs from external.
  dirty: boolean;
  // Replace the body, recombining with the verbatim frontmatter block.
  setBody: (body: string) => void;
  // Set the frontmatter title. Newlines are stripped (a YAML scalar can't hold
  // them); Enter in the title input is handled by the dialog as a focus move.
  setTitle: (title: string) => void;
  // Replace the entire file (the raw full-file textarea).
  setRaw: (raw: string) => void;
  // Set/remove arbitrary scalar frontmatter keys (e.g. a note's `type` pill),
  // leaving the body and other keys untouched. Returns the new content so a
  // caller can persist it directly.
  setFrontmatter: (updates: Record<string, string | undefined>) => string;
}

export function useFrontmatterDocument(content: string): FrontmatterDocument {
  const [draft, setDraft] = useState(() => content);

  // `draftRef` mirrors `draft` synchronously so mutations and the external-edit
  // guard read the latest value without stale closures.
  const draftRef = useRef(draft);
  // The last `content` we've reconciled with. Lets the adoption effect tell a
  // genuine outside write apart from our own save echoing back.
  const syncedContentRef = useRef(content);

  function updateDraft(next: string) {
    draftRef.current = next;
    setDraft(next);
  }

  // Live-following: another writer (e.g. an agent, or the daemon auto-titling a
  // task, or honoring a direct disk edit) can edit the open file. A clean editor
  // adopts the external write wholesale. A DIRTY editor no longer drops the update
  // — it merges per field (mergeFrontmatterUpdate): the user's outstanding title /
  // body edits survive, while machine-owned frontmatter and the fields the user
  // hasn't touched adopt the external value. Either way we rebase the dirty
  // baseline onto the incoming content, so `dirty` stays coherent (the draft
  // remains dirty iff a user-edited field still differs from external). Adoption
  // is purely string-level: a controlled MarkdownEditor picks up a changed body
  // through its `value` prop — and the merge keeps the body byte-identical when it
  // was locally edited, so the editor isn't reset mid-type.
  useEffect(() => {
    if (content === syncedContentRef.current) return; // our own echo / mount
    const synced = syncedContentRef.current;
    const local = draftRef.current;
    const userEdited = local !== synced;
    syncedContentRef.current = content;
    if (!userEdited) {
      updateDraft(content);
      return;
    }
    updateDraft(mergeFrontmatterUpdate({ local, synced, external: content }));
  }, [content]);

  const frontmatter = parseFrontmatter(draft).frontmatter;

  function setBody(nextBody: string) {
    // Recombine a body edit with the verbatim frontmatter block. Frontmatter
    // never enters the editor, so it stays byte-for-byte identical across edit
    // + save.
    const { frontmatterBlock } = splitFrontmatter(draftRef.current);
    updateDraft(frontmatterBlock + nextBody);
  }

  function setTitle(title: string) {
    updateDraft(
      setFrontmatterKeys(draftRef.current, {
        title: title.replace(/\r?\n/g, " "),
      }),
    );
  }

  function setRaw(raw: string) {
    updateDraft(raw);
  }

  function setFrontmatter(updates: Record<string, string | undefined>): string {
    const next = setFrontmatterKeys(draftRef.current, updates);
    updateDraft(next);
    return next;
  }

  return {
    raw: draft,
    getLatestRaw: () => draftRef.current,
    body: splitFrontmatter(draft).body,
    title: rawTitle(draft),
    frontmatter,
    dirty: draft !== content,
    setBody,
    setTitle,
    setRaw,
    setFrontmatter,
  };
}
