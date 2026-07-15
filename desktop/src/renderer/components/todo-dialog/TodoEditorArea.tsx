"use client";

import type { useAttachments } from "@/hooks/useAttachments";
import type { TaskDraft } from "@/hooks/useTaskDraft";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
  type SkillMenuItem,
  type SnippetMenuItem,
} from "@/editor";

// The dialog's document area across BOTH stages. One MarkdownEditor instance
// serves capture and saved (it must never remount on the stage flip — focus,
// caret, and undo history ride through the transform); the raw view exists only
// once saved. The title lives in the shell's header row (TodoDialog), not here —
// it's window chrome, not content, so the body is the document area's largest,
// darkest element. Scrolls near the viewport cap while the shell pins the
// footer below.
export function TodoEditorArea({
  stage,
  view,
  draft,
  editorRef,
  rawRef,
  attachments,
  skills,
  snippets,
  onSaveSnippet,
}: {
  stage: "capture" | "saved";
  view: "raw" | "formatted";
  draft: TaskDraft;
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
  rawRef: React.RefObject<HTMLTextAreaElement | null>;
  attachments: ReturnType<typeof useAttachments>;
  skills: ReadonlyArray<SkillMenuItem>;
  snippets: ReadonlyArray<SnippetMenuItem>;
  onSaveSnippet: (name: string, body: string) => Promise<void>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {view === "raw" && stage === "saved" ? (
        // pt-4 only: the ⋯/✕ header row sits above in normal flow (it used to
        // float absolutely, which this textarea's old pt-10 cleared).
        <textarea
          ref={rawRef}
          aria-label="Todo content"
          value={draft.raw}
          onChange={(e) => draft.setRaw(e.target.value)}
          spellCheck={false}
          className="hitch-autosize min-h-[180px] w-full shrink-0 resize-none overflow-hidden bg-transparent px-5 pt-4 pb-4 font-mono text-xs leading-relaxed outline-none"
        />
      ) : (
        <div className="flex flex-col px-5">
          {/* Capture keeps the card tiny: `hitch-capture-compact` lowers the
              editor's 180px min-height floor to JV0-0's compact proportions
              (see styles.css); the saved stage is a document and keeps the
              default, sitting pt-3 below the shell's header row. */}
          <div
            className={
              stage === "capture"
                ? "hitch-capture-compact pt-5 pb-3"
                : "pt-3 pb-4"
            }
          >
            <MarkdownEditor
              ref={editorRef}
              value={draft.body}
              onChange={draft.setBody}
              placeholder={
                stage === "capture"
                  ? "What needs doing?"
                  : "Describe what you're working on, or drop in a screenshot or file"
              }
              imageUploadHandler={
                attachments.enabled ? attachments.imageUploadHandler : undefined
              }
              imagePreviewHandler={
                attachments.enabled
                  ? attachments.imagePreviewHandler
                  : undefined
              }
              skills={skills}
              snippets={snippets}
              onSaveSnippet={onSaveSnippet}
            />
          </div>
        </div>
      )}
    </div>
  );
}
