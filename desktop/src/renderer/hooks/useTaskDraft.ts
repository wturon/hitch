"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseFrontmatter,
  setFrontmatterKeys,
  splitFrontmatter,
  type Frontmatter,
} from "@/lib/frontmatter";
import {
  clearChatFields,
  parseChatOpenState,
  parseChatRef,
  parseChatStatus,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";

// Read the frontmatter `title` WITHOUT trimming. The title input is controlled by
// this value, and `parseFrontmatter` trims — so a trailing space the user just
// typed would be stripped on the round-trip, making the spacebar look broken in
// the title. Reading the raw line (minus the single separator space) preserves it.
function rawTitle(content: string): string {
  const { frontmatterBlock } = splitFrontmatter(content);
  const match = frontmatterBlock.match(/^title:(.*)$/m);
  return match ? match[1].replace(/^ /, "") : "";
}

// The in-memory document model for a single open task. It owns ONLY the document:
// the whole-file draft (frontmatter + body), the views derived from it, the
// mutations that edit it, the dirty flag, and adoption of external writes. It
// deliberately knows nothing about persistence (Convex), the dialog's close
// policy, or MDXEditor — those stay in TaskDialog so this stays a reusable,
// side-effect-light model.
//
// `content` is the live task file text from the query. The hook is mounted fresh
// per task (TaskEditor is keyed by `task.path`), so `useState(() => content)` is
// the correct initialization — there is no "task switched under us" case to
// handle here; a different task remounts the hook. Don't remove that key.
export interface TaskDraft {
  // The whole-file draft (frontmatter + body), edited verbatim and written back
  // byte-for-byte. This is the canonical value.
  raw: string;
  // The body half only — what the friendly editor sees. Frontmatter never enters
  // the formatted editor; it's recombined verbatim on every body edit.
  body: string;
  // The untrimmed frontmatter title (see `rawTitle`).
  title: string;
  frontmatter: Frontmatter;
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  chatOpenState: ChatOpenState | null;
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
  // Strip every chat-* field. Returns the new content so the caller can persist
  // it (only frontmatter changes, so the body editor needs no update).
  clearChat: () => string;
}

export function useTaskDraft(content: string): TaskDraft {
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

  // Live-following: another writer (e.g. the agent linking a session) can edit
  // the open task file. Adopt the external change only when the user has no
  // in-progress edits — never clobber a dirty editor. The human's draft wins on
  // close (last-write-wins). Adoption is purely string-level: a controlled
  // MarkdownEditor picks up the new body through its `value` prop on its own.
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

  function clearChat() {
    const cleared = clearChatFields(draftRef.current);
    updateDraft(cleared);
    return cleared;
  }

  return {
    raw: draft,
    body: splitFrontmatter(draft).body,
    title: rawTitle(draft),
    frontmatter,
    chat: parseChatRef(frontmatter),
    chatStatus: parseChatStatus(frontmatter),
    chatOpenState: parseChatOpenState(frontmatter),
    dirty: draft !== content,
    setBody,
    setTitle,
    setRaw,
    clearChat,
  };
}
