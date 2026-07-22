import { useEffect, useRef } from "react";

import type { MarkdownEditorHandle } from "@/editor";
import { hrefToAttachmentRef } from "./attachmentModel";
import type { AttachmentsV2 } from "./useAttachmentsV2";

// The dialog-wide file paste/drop plumbing for TaskDialogV2 — V1's
// useCaptureAttachments (components/todo-dialog/) ported onto server rows.
// Native capture-phase listeners on the dialog root route every file ingress
// through ONE materialize-early path: a file paste/drop is the one thing that
// creates the task ROW before ⌘⏎ (V1 Decision 3 — attachments need a parent),
// and the dialog's capture-stage dismiss deletes that row again on esc.
// Bound once for the dialog's life; every moving part is read through refs.
//
// Deltas vs V1: no viewRef (V2 has no raw view — the editor owns an all-image
// paste whenever the task is committed), and a ⌘-click listener that resolves
// a non-image attachment link to a presigned GET before opening it (V1's
// ⌘-click opened the raw relative href; V2's refs only resolve server-side).
export function useCaptureAttachmentsV2({
  rootRef,
  docRef,
  editorRef,
  committedRef,
  attachmentsRef,
  materializeEarly,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  // Live document accessor (body + setBody) — the dialog's useTaskDocument,
  // mirrored into a ref by the caller.
  docRef: React.RefObject<{ body: string; setBody: (body: string) => void }>;
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
  // Live committed task id (null until materialized).
  committedRef: React.RefObject<string | null>;
  // Live useAttachmentsV2 instance (re-binds when the task id appears).
  attachmentsRef: React.RefObject<AttachmentsV2>;
  // Create the task row with a provisional title so uploads have a parent (the
  // ⌘⏎ transform overwrites title/body later). Owned by the dialog — it
  // touches the POST + sortOrder + the optimistic tasks cache.
  materializeEarly: () => Promise<void>;
}): void {
  // Uploads need a task row; materialize first, then wait for the re-render
  // that re-binds useAttachmentsV2 to the new task id (`enabled` flips) before
  // uploading through the refreshed instance. V1 waited a single rAF, but
  // here the id lands via setState after an awaited POST, and React 18
  // schedules that commit as a macrotask — one rAF can beat it. So: poll
  // frames until the rebind is visible, bounded so a dropped commit degrades
  // into the upload's own "not available" error instead of a hang.
  async function attachmentsForUpload(): Promise<AttachmentsV2> {
    if (committedRef.current) return attachmentsRef.current;
    await materializeEarly();
    for (let i = 0; i < 60 && !attachmentsRef.current.enabled; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return attachmentsRef.current;
  }

  // Uploaded markdown lands at the end of the body — predictable, and matches
  // how attachments accrue in the dialog (V1 verbatim).
  function appendToBody(snippets: string[]) {
    if (snippets.length === 0) return;
    const doc = docRef.current;
    const base = doc.body.replace(/\s*$/, "");
    const additions = snippets.join("\n\n");
    doc.setBody(base ? `${base}\n\n${additions}\n` : `${additions}\n`);
    requestAnimationFrame(() => editorRef.current?.focusEnd());
  }

  // Latest handlers, read by the stable native listeners below.
  const onPasteFilesRef = useRef<(files: File[]) => void>(() => {});
  onPasteFilesRef.current = (files: File[]) => {
    void attachmentsForUpload()
      .then((a) => a.uploadPasted(files))
      .then(appendToBody);
  };
  const onDropFilesRef = useRef<(files: File[]) => void>(() => {});
  onDropFilesRef.current = (files: File[]) => {
    void attachmentsForUpload()
      .then((a) => a.uploadDropped(files))
      .then(appendToBody);
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onDropFilesRef.current(files);
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      const allImages = files.every((f) => f.type.startsWith("image/"));
      // An image-only paste with a task row already present goes to the
      // editor's own caret-insertion plugin (PasteImagePlugin); everything
      // else (no row yet, or non-image files) we take and append.
      if (allImages && committedRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      onPasteFilesRef.current(files);
    };
    // ⌘/Ctrl-click on one of our attachment links: resolve the relative ref to
    // a presigned GET before it opens. Capture phase, so it wins over the
    // editor's own ⌘-click handler (which would window.open the DOM href —
    // Lexical renders our ref as the unresolvable `https://attachments/<name>`;
    // hrefToAttachmentRef normalizes that back).
    const onClick = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const anchor = target.closest("a");
      if (!anchor || !el.contains(anchor)) return;
      const ref = hrefToAttachmentRef(anchor.getAttribute("href") ?? "");
      if (ref === null) return;
      e.preventDefault();
      e.stopPropagation();
      void attachmentsRef.current.openAttachmentRef(ref).catch((err) => {
        console.error("Failed to open attachment", err);
      });
    };
    el.addEventListener("dragover", onOver, true);
    el.addEventListener("drop", onDrop, true);
    el.addEventListener("paste", onPaste, true);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("dragover", onOver, true);
      el.removeEventListener("drop", onDrop, true);
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("click", onClick, true);
    };
    // Bound once for the dialog's life — every moving part is read through a
    // ref, so the listeners never need to re-bind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
