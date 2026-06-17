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

// The in-memory document model for a single open frontmatter markdown file. It
// owns ONLY the document: the whole-file draft (frontmatter + body), the views
// derived from it, the generic mutations that edit it, the dirty flag, and
// adoption of external writes. It deliberately knows nothing about persistence
// (Convex), any dialog's close policy, or MDXEditor.
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
  // The body half only — what the friendly editor sees. Frontmatter never enters
  // the formatted editor; it's recombined verbatim on every body edit.
  body: string;
  // The untrimmed frontmatter title (see `rawTitle`).
  title: string;
  frontmatter: Frontmatter;
  // True when the draft diverges from the live file content. Baseline is the
  // current `content` prop, so an adopted external write resets it to clean.
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

  // Live-following: another writer (e.g. an agent, or the daemon honoring a
  // direct disk edit) can edit the open file. Adopt the external change only
  // when the user has no in-progress edits — never clobber a dirty editor. The
  // human's draft wins on close (last-write-wins). Adoption is purely
  // string-level: a controlled MarkdownEditor picks up the new body through its
  // `value` prop on its own.
  useEffect(() => {
    if (content === syncedContentRef.current) return; // our own echo / mount
    const userEdited = draftRef.current !== syncedContentRef.current;
    syncedContentRef.current = content;
    if (userEdited) return;
    updateDraft(content);
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
