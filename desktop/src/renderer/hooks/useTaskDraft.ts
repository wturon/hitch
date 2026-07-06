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
  parseDelegationRequest,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
  type DelegationRequest,
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
  // The pre-link "summoning" flag, if a delegation is in flight (or failed) and
  // no real chat has bound yet. Null once `chat` is present.
  request: DelegationRequest | null;
  // Strip every chat-* field (including the request flag). Returns the new content
  // so the caller can persist it (only frontmatter changes, so the body editor
  // needs no update).
  clearChat: () => string;
}

export function useTaskDraft(content: string): TaskDraft {
  // Tasks let the user edit exactly one frontmatter key — the title. Every other
  // key (chat-*, completed-at, …) is machine-owned, so an external write into a
  // dirty editor always refreshes them (see mergeFrontmatterUpdate).
  const doc = useFrontmatterDocument(content, { userOwnedKeys: ["title"] });

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
    request: parseDelegationRequest(doc.frontmatter),
    clearChat,
  };
}
