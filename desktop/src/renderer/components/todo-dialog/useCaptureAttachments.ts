"use client";

import { useEffect, useRef } from "react";

import type { useAttachments } from "@/hooks/useAttachments";
import type { TaskDraft } from "@/hooks/useTaskDraft";
import type { MarkdownEditorHandle } from "@/editor";

type Attachments = ReturnType<typeof useAttachments>;

// The dialog-wide file paste/drop plumbing for the todo dialog: native
// capture-phase listeners on the dialog root route every file ingress through
// ONE materialize-early path (Decision 3 — a pasted image is the one thing that
// creates the task dir before ⌘⏎; the shell's discard-cleanup deletes it on
// esc-esc). Mirrors TaskDialog's listener strategy: bound once for the dialog's
// life, every moving part read live through refs.
export function useCaptureAttachments({
  rootRef,
  draft,
  editorRef,
  viewRef,
  committedRef,
  attachmentsRef,
  materializeEarly,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  draft: TaskDraft;
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
  // Live view mode ("raw" | "formatted") — decides who owns an image paste.
  viewRef: React.RefObject<string>;
  // Live committed path (null until materialized).
  committedRef: React.RefObject<string | null>;
  // Live useAttachments instance (re-created when the slug appears).
  attachmentsRef: React.RefObject<Attachments>;
  // Commit the draft with a provisional title so uploads have a task folder
  // (the ⌘⏎ split overwrites the title later). Owned by the shell — it touches
  // slug minting and the optimistic write.
  materializeEarly: () => Promise<void>;
}): void {
  // Uploads need a task folder; materialize first, then wait a frame for
  // useAttachments to adopt the new slug before uploading through the
  // refreshed instance.
  async function attachmentsForUpload(): Promise<Attachments> {
    if (committedRef.current) return attachmentsRef.current;
    await materializeEarly();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return attachmentsRef.current;
  }

  // Uploaded markdown lands at the end of the body — predictable, and matches
  // how attachments accrue in the task dialog.
  function appendToBody(snippets: string[]) {
    if (snippets.length === 0) return;
    const base = draft.body.replace(/\s*$/, "");
    const additions = snippets.join("\n\n");
    draft.setBody(base ? `${base}\n\n${additions}\n` : `${additions}\n`);
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
      // An image-only paste in the formatted editor with a slug already present
      // goes to the editor's own caret-insertion plugin; everything else (no
      // slug yet, raw view, or non-image files) we take and append.
      if (
        viewRef.current === "formatted" &&
        allImages &&
        committedRef.current
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onPasteFilesRef.current(files);
    };
    el.addEventListener("dragover", onOver, true);
    el.addEventListener("drop", onDrop, true);
    el.addEventListener("paste", onPaste, true);
    return () => {
      el.removeEventListener("dragover", onOver, true);
      el.removeEventListener("drop", onDrop, true);
      el.removeEventListener("paste", onPaste, true);
    };
    // Bound once for the dialog's life — every moving part is read through a
    // ref, so the listeners never need to re-bind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
