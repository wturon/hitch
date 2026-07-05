"use client";

import type { useAttachments } from "@/hooks/useAttachments";
import type { TaskDraft } from "@/hooks/useTaskDraft";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
  type SkillMenuItem,
} from "@/editor";

// The dialog's document area across BOTH stages. One MarkdownEditor instance
// serves capture and saved (it must never remount on the stage flip — focus,
// caret, and undo history ride through the transform); the title textarea and
// the raw view exist only once saved. Scrolls near the viewport cap while the
// shell pins the footer below.
export function TodoEditorArea({
  stage,
  view,
  draft,
  disarm,
  editorRef,
  titleRef,
  rawRef,
  attachments,
  skills,
}: {
  stage: "capture" | "saved";
  view: "raw" | "formatted";
  draft: TaskDraft;
  // Any edit disarms the discard guard (Decision 4).
  disarm: () => void;
  editorRef: React.RefObject<MarkdownEditorHandle | null>;
  titleRef: React.RefObject<HTMLTextAreaElement | null>;
  rawRef: React.RefObject<HTMLTextAreaElement | null>;
  attachments: ReturnType<typeof useAttachments>;
  skills: ReadonlyArray<SkillMenuItem>;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {view === "raw" && stage === "saved" ? (
        <textarea
          ref={rawRef}
          aria-label="Todo content"
          value={draft.raw}
          onChange={(e) => {
            disarm();
            draft.setRaw(e.target.value);
          }}
          spellCheck={false}
          className="hitch-autosize min-h-[180px] w-full shrink-0 resize-none overflow-hidden bg-transparent px-5 pt-10 pb-4 font-mono text-xs leading-relaxed outline-none"
        />
      ) : (
        <div className="flex flex-col px-5">
          {stage === "saved" && (
            <textarea
              ref={titleRef}
              aria-label="Todo title"
              rows={1}
              value={draft.title}
              onChange={(e) => {
                disarm();
                draft.setTitle(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  editorRef.current?.focusStart();
                }
              }}
              placeholder="Untitled"
              spellCheck={false}
              className="hitch-autosize mt-10 mb-2 w-full shrink-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-[18px] font-semibold leading-6 tracking-[-0.01em] text-[#0B0B0B] outline-none placeholder:text-muted-foreground/40 dark:text-foreground"
            />
          )}
          {/* Capture keeps the card tiny: `hitch-capture-compact` lowers the
              editor's 180px min-height floor to JV0-0's compact proportions
              (see styles.css); the saved stage is a document and keeps the
              default. */}
          <div
            className={
              stage === "capture" ? "hitch-capture-compact pt-5 pb-3" : "pb-4"
            }
          >
            <MarkdownEditor
              ref={editorRef}
              value={draft.body}
              onChange={(v) => {
                disarm();
                draft.setBody(v);
              }}
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
            />
          </div>
        </div>
      )}
    </div>
  );
}
