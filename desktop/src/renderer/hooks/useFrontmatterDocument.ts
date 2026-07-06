"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseFrontmatter,
  setFrontmatterKeys,
  splitFrontmatter,
  type Frontmatter,
} from "@/lib/frontmatter";

// Read a frontmatter key's value WITHOUT trimming. The title input is controlled
// by this value, and `parseFrontmatter` trims — so a trailing space the user just
// typed would be stripped on the round-trip, making the spacebar look broken in
// the title. Reading the raw line (minus the single separator space) preserves
// it. Generalized over `key` so the merge below applies the same untrimmed
// comparison to every caller-declared user-owned key.
function rawKeyValue(content: string, key: string): string {
  const { frontmatterBlock } = splitFrontmatter(content);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatterBlock.match(new RegExp(`^${escaped}:(.*)$`, "m"));
  return match ? match[1].replace(/^ /, "") : "";
}

function rawTitle(content: string): string {
  return rawKeyValue(content, "title");
}

// Field-aware merge of an external write into a DIRTY draft. The contract:
// callers DECLARE which frontmatter keys their UI lets the user edit
// (`userOwnedKeys` — ["title"] for tasks, ["title", "type"] for notes); the body
// is always user-owned. Everything NOT declared is machine-owned (chat-*,
// completed-at, chat-request…) and is ALWAYS taken from the external write. That
// last part also closes a pre-existing hole: the old all-or-nothing guard skipped
// a dirty editor's update entirely, so the eventual whole-doc save on close
// clobbered any daemon frontmatter stamp landed meanwhile (e.g. a chat binding).
// Now those keys ride through untouched.
//
// Per user-owned field: keep the local value only when the user actually edited
// it from the last-synced baseline, else adopt the external value. The result is
// rebuilt from the EXTERNAL frontmatter with only the *edited* user keys spliced
// back in and the chosen body appended — so machine keys stay current while
// outstanding user edits survive. Crucially, when the body was locally edited the
// chosen body IS the local body, byte-identical to the draft's current body, so
// the controlled MarkdownEditor's `value` prop doesn't change and the Lexical
// body editor is not reset out from under the typing user.
//
// `claimedKeys` strengthens the contract for keys the user has CLAIMED without
// necessarily editing (e.g. focusing the title input): a claimed key is treated
// as user-edited unconditionally, so the LOCAL value is spliced into the result
// even when local equals the synced baseline — the external value is never
// adopted. Claimed keys should be a subset of userOwnedKeys.
export function mergeFrontmatterUpdate(input: {
  local: string; // the current dirty draft
  synced: string; // the baseline the draft was last reconciled against
  external: string; // the incoming external content
  // The frontmatter keys the caller's UI lets the user edit. Only these can hold
  // a protected local edit; every other key adopts external unconditionally.
  userOwnedKeys: readonly string[];
  // User-owned keys the user has claimed ownership of this session (see above):
  // kept local even when untouched.
  claimedKeys?: readonly string[];
}): string {
  const { local, synced, external, userOwnedKeys } = input;
  const claimed = new Set(input.claimedKeys ?? []);

  const bodyEdited =
    splitFrontmatter(local).body !== splitFrontmatter(synced).body;
  const chosenBody = bodyEdited
    ? splitFrontmatter(local).body
    : splitFrontmatter(external).body;

  // A user-owned key is kept local only if it was actually edited (local ≠
  // synced for that key) OR claimed. An untouched, unclaimed key isn't spliced
  // at all, so it adopts whatever the external frontmatter carries — including
  // absence. A locally-cleared key splices "", which setFrontmatterKeys drops,
  // honoring the removal.
  const editedKeys: Record<string, string> = {};
  for (const key of userOwnedKeys) {
    const localValue = rawKeyValue(local, key);
    if (claimed.has(key) || localValue !== rawKeyValue(synced, key)) {
      editedKeys[key] = localValue;
    }
  }

  // Rebuild on the external frontmatter (machine keys always win); splice the
  // edited user keys back in place, then swap the body for the chosen one.
  const withEdits = Object.keys(editedKeys).length
    ? setFrontmatterKeys(external, editedKeys)
    : external;
  const { frontmatterBlock } = splitFrontmatter(withEdits);
  return frontmatterBlock + chosenBody;
}

// The in-memory document model for a single open frontmatter markdown file. It
// owns ONLY the document: the whole-file draft (frontmatter + body), the views
// derived from it, the generic mutations that edit it, the dirty flag, and
// adoption of external writes. It deliberately knows nothing about persistence
// (Convex), any dialog's close policy, or the editor component.
//
// This is the primitive-agnostic core shared by tasks and notes. Task-only
// machinery (chat-* selectors, clearChat) layers on top in useTaskDraft. The one
// piece of per-caller policy the hook needs is which frontmatter keys the user
// can edit through the caller's UI (options.userOwnedKeys) — those are protected
// through a dirty merge; every other key is machine-owned and always adopts an
// external write.
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

export interface FrontmatterDocumentOptions {
  // The frontmatter keys this document's UI lets the user edit — the fields the
  // dirty-merge protects (see mergeFrontmatterUpdate). Tasks declare ["title"];
  // notes declare ["title", "type"] (the type pill). Defaults to ["title"], the
  // one key the hook itself edits via setTitle; callers with more user-editable
  // frontmatter MUST declare it or a dirty merge will adopt external over the
  // user's in-progress edit.
  userOwnedKeys?: readonly string[];
  // A getter (read at merge time, like userOwnedKeys) for the user-owned keys
  // the user has CLAIMED this session without necessarily editing — e.g. a
  // focused-but-untouched title input. A claimed key never adopts an external
  // write, even into a clean draft (see mergeFrontmatterUpdate).
  claimedKeys?: () => readonly string[];
}

const DEFAULT_USER_OWNED_KEYS: readonly string[] = ["title"];

export function useFrontmatterDocument(
  content: string,
  options?: FrontmatterDocumentOptions,
): FrontmatterDocument {
  const userOwnedKeys = options?.userOwnedKeys ?? DEFAULT_USER_OWNED_KEYS;
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

  // Mirror the declared user-owned keys so the adoption effect (deps: [content])
  // always merges with the caller's latest declaration, even when it's an inline
  // array literal recreated every render. Same for the claimed-keys getter.
  const userOwnedKeysRef = useRef(userOwnedKeys);
  userOwnedKeysRef.current = userOwnedKeys;
  const claimedKeysRef = useRef(options?.claimedKeys);
  claimedKeysRef.current = options?.claimedKeys;

  // Live-following: another writer (e.g. an agent, or the daemon auto-titling a
  // task, or honoring a direct disk edit) can edit the open file. A clean editor
  // with no claimed keys adopts the external write wholesale. A DIRTY editor no
  // longer drops the update — it merges per field (mergeFrontmatterUpdate): the
  // user's outstanding edits to the body and the declared user-owned keys
  // survive, while machine-owned frontmatter and the fields the user hasn't
  // touched adopt the external value. A CLEAN draft with claimed keys takes the
  // merge path too — that's exactly the focused-but-untouched case, where the
  // claimed key must keep its local value instead of being swapped out from
  // under the user's cursor. Either way we rebase the dirty baseline onto the
  // incoming content, so `dirty` stays coherent (the draft remains dirty iff a
  // user-edited or claimed field still differs from external). Adoption is
  // purely string-level: a controlled MarkdownEditor picks up a changed body
  // through its `value` prop — and the merge keeps the body byte-identical when
  // it was locally edited, so the editor isn't reset mid-type.
  useEffect(() => {
    if (content === syncedContentRef.current) return; // our own echo / mount
    const synced = syncedContentRef.current;
    const local = draftRef.current;
    const userEdited = local !== synced;
    const claimed = claimedKeysRef.current?.() ?? [];
    syncedContentRef.current = content;
    if (!userEdited && claimed.length === 0) {
      updateDraft(content);
      return;
    }
    updateDraft(
      mergeFrontmatterUpdate({
        local,
        synced,
        external: content,
        userOwnedKeys: userOwnedKeysRef.current,
        claimedKeys: claimed,
      }),
    );
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
