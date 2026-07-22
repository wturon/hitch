import { useCallback, useEffect, useRef, useState } from "react";

// The V2 document hook (M2 PR 3): the simplified successor to V1's
// useFrontmatterDocument for server-backed tasks. The server row already
// separates {title, body} into columns, so there is no frontmatter to parse,
// no whole-file draft, and no machine-owned keys to merge around — just two
// user-owned fields with per-field dirty tracking against the live row.
//
// The invariant it preserves from V1 (the single-binding design): a task that
// exists on the server has exactly one source of truth — the live query row.
// Local state is only (a) a draft for a task that doesn't exist yet (capture:
// `row` is undefined), or (b) unsaved edits held over the live row. Per field:
//
//   • CLEAN (local === last-synced row value) → adopt an external change
//     wholesale; the field simply follows the row.
//   • DIRTY (local ≠ last-synced) → keep local, rebase the synced baseline
//     onto the incoming row. Crucially this is a byte-compare: our own save
//     echoing back through the WS-driven refetch arrives with the row equal to
//     local, so nothing changes — the controlled MarkdownEditor's `value` prop
//     is untouched and the Lexical editor is never reset mid-type.
//
// The FIRST row arrival (a capture's POST just committed and the live query
// resolved it) is a pure rebase: local is kept verbatim — it IS what was
// posted — and any keystrokes that landed while the POST was in flight stay
// as ordinary dirty edits, picked up by the next autosave/flush.
//
// Persistence: ~1.5s idle-debounce autosave + an explicit flush() for
// save-on-close. Single user → last-write-wins; a PATCH carries only the
// dirty fields. Saves are serialized through a promise chain so an autosave
// and a close-flush can never reorder on the wire.

export interface TaskDocumentFields {
  title: string;
  body: string;
}

export interface TaskDocument {
  title: string;
  body: string;
  // Set the title. Newlines are stripped (single-line input; Enter is a focus
  // move in the dialog), mirroring V1's setTitle.
  setTitle: (title: string) => void;
  setBody: (body: string) => void;
  // True when a field diverges from the live row. Always false while
  // uncommitted (`row` undefined) — a capture draft has nothing to be dirty
  // against; it persists through POST, not PATCH.
  dirty: boolean;
  // Cancel any pending autosave and persist the dirty fields NOW. Resolves
  // once the PATCH lands; rejects on failure (the fields stay dirty, so a
  // later flush retries). No-op while uncommitted or clean.
  flush: () => Promise<void>;
}

const AUTOSAVE_MS = 1500;

export function useTaskDocument({
  row,
  initial,
  persist,
  autosaveMs = AUTOSAVE_MS,
}: {
  // The live query row's document fields; undefined while the task doesn't
  // exist on the server yet (capture stage).
  row: TaskDocumentFields | undefined;
  // Seed for the local draft when mounting WITHOUT a row (capture — e.g. the
  // localStorage recovery draft). Ignored when `row` is present at mount.
  initial?: TaskDocumentFields;
  // Write the dirty fields to the server (PATCH via the hc client). Only ever
  // called once committed.
  persist: (patch: Partial<TaskDocumentFields>) => Promise<void>;
  autosaveMs?: number;
}): TaskDocument {
  const [local, setLocal] = useState<TaskDocumentFields>(
    () => row ?? initial ?? { title: "", body: "" },
  );
  // Sync mirrors so async callbacks (flush, the debounce timer) and the
  // adoption effect read the latest values without stale closures.
  const localRef = useRef(local);
  const rowRef = useRef(row);
  rowRef.current = row;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  // The last row values reconciled against — the per-field dirty baseline.
  // undefined until the first row arrives.
  const syncedRef = useRef<TaskDocumentFields | undefined>(
    row ? { title: row.title, body: row.body } : undefined,
  );

  const timerRef = useRef<number | null>(null);
  // Serialize saves: each flush chains behind the previous one.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  function updateLocal(next: TaskDocumentFields) {
    localRef.current = next;
    setLocal(next);
  }

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = useCallback(async () => {
    clearTimer();
    const target = rowRef.current;
    if (!target) return; // uncommitted: capture persists via POST, not PATCH
    const current = localRef.current;
    const patch: Partial<TaskDocumentFields> = {};
    if (current.title !== target.title) patch.title = current.title;
    if (current.body !== target.body) patch.body = current.body;
    if (patch.title === undefined && patch.body === undefined) return;
    const run = chainRef.current.then(() => persistRef.current(patch));
    // The chain must survive a rejection (a failed autosave shouldn't wedge
    // every later save); the caller still sees the rejection through `run`.
    chainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const scheduleAutosave = useCallback(() => {
    if (!rowRef.current) return; // nothing to PATCH yet
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      // Autosave failures are non-fatal: the fields stay dirty and the next
      // edit or the close-flush retries.
      void flushRef.current().catch((err) => console.error("Task autosave failed", err));
    }, autosaveMs);
  }, [autosaveMs]);

  // Adoption of external row changes (see header). Depends on the VALUES, not
  // the row object identity — callers may rebuild the fields object per render.
  const rowTitle = row?.title;
  const rowBody = row?.body;
  useEffect(() => {
    if (rowTitle === undefined || rowBody === undefined) return;
    const synced = syncedRef.current;
    syncedRef.current = { title: rowTitle, body: rowBody };
    const current = localRef.current;
    if (!synced) {
      // First arrival (capture just committed): pure rebase, keep local
      // verbatim. If keystrokes landed while the POST was in flight the draft
      // is now dirty against the row — schedule the autosave that the
      // uncommitted stage couldn't.
      if (current.title !== rowTitle || current.body !== rowBody) {
        scheduleAutosave();
      }
      return;
    }
    const next: TaskDocumentFields = {
      title: current.title === synced.title ? rowTitle : current.title,
      body: current.body === synced.body ? rowBody : current.body,
    };
    // Byte-compare before setState: our own echo (external === local) must not
    // re-render, let alone reset the editor.
    if (next.title !== current.title || next.body !== current.body) {
      updateLocal(next);
    }
  }, [rowTitle, rowBody, scheduleAutosave]);

  // Unmount: drop the pending timer. Deliberately NO flush here — the dialog's
  // dismiss path owns save-on-close explicitly, and an unmount-flush would
  // double-fire behind it.
  useEffect(() => clearTimer, []);

  function setTitle(title: string) {
    updateLocal({
      ...localRef.current,
      title: title.replace(/\r?\n/g, " "),
    });
    scheduleAutosave();
  }

  function setBody(body: string) {
    updateLocal({ ...localRef.current, body });
    scheduleAutosave();
  }

  return {
    title: local.title,
    body: local.body,
    setTitle,
    setBody,
    dirty: row !== undefined && (local.title !== row.title || local.body !== row.body),
    flush,
  };
}
