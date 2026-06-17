"use client";

import {
  useFrontmatterDocument,
  type FrontmatterDocument,
} from "@/hooks/useFrontmatterDocument";
import {
  clearChatFields,
  parseChatOpenState,
  parseChatRef,
  parseChatStatus,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";

// The in-memory document model for a single open task. It is the generic
// frontmatter document (raw/body/title/frontmatter/dirty + mutations — see
// useFrontmatterDocument) plus the task-only chat-* selectors and clearChat.
//
// The hook is mounted fresh per task (TaskEditor is keyed by `task.path`), so
// the generic core initializes from `content` once — don't remove that key.
export interface TaskDraft extends FrontmatterDocument {
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  chatOpenState: ChatOpenState | null;
  // Strip every chat-* field. Returns the new content so the caller can persist
  // it (only frontmatter changes, so the body editor needs no update).
  clearChat: () => string;
}

export function useTaskDraft(content: string): TaskDraft {
  const doc = useFrontmatterDocument(content);

  function clearChat(): string {
    // Recompute from the live draft, then write it back through the generic
    // setter (only frontmatter changes, so the body editor needs no update).
    const cleared = clearChatFields(doc.raw);
    doc.setRaw(cleared);
    return cleared;
  }

  return {
    ...doc,
    chat: parseChatRef(doc.frontmatter),
    chatStatus: parseChatStatus(doc.frontmatter),
    chatOpenState: parseChatOpenState(doc.frontmatter),
    clearChat,
  };
}
