"use client";

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  chatRowViewModel,
  type ChatLinkedType,
  type ChatMutationInput,
  type ChatRowViewModel,
  type StartChatInput,
} from "@/lib/chats";

export interface ChatQueryOptions {
  deviceToken?: string;
}

// The chat linked to a specific doc (note index.md / task task.md), resolved by
// the `by_link` index rather than scraped from a screen list — so it holds even
// for an idle chat that's fallen off the recent window. `undefined` while the
// query is loading, `null` once loaded with no active match.
export function useChatByLink(
  projectId: Id<"projects"> | null | undefined,
  linkedType: ChatLinkedType,
  linkedPath: string | null | undefined,
  options: Pick<ChatQueryOptions, "deviceToken"> = {},
): ChatRowViewModel | null | undefined {
  const result = useQuery(
    api.chats.getChatByLink,
    projectId && linkedPath
      ? {
          projectId,
          linkedType,
          linkedPath,
          ...(options.deviceToken ? { deviceToken: options.deviceToken } : {}),
        }
      : "skip",
  );

  return useMemo(() => {
    if (result === undefined) return undefined; // loading (or skipped)
    return result ? chatRowViewModel(result) : null;
  }, [result]);
}

export function useChatActions() {
  const startChatMutation = useMutation(api.chats.startChat);
  const resumeChatMutation = useMutation(api.chats.resumeChat);
  const setPinnedMutation = useMutation(api.chats.setPinned);
  const setArchivedMutation = useMutation(api.chats.setArchived);
  const deleteChatMutation = useMutation(api.chats.deleteChat);

  return useMemo(
    () => ({
      startChat: (input: StartChatInput) => startChatMutation(input),
      resumeChat: ({ projectId, id }: ChatMutationInput) =>
        resumeChatMutation({ projectId, id }),
      pinChat: ({ projectId, id }: ChatMutationInput) =>
        setPinnedMutation({ projectId, id, pinned: true }),
      unpinChat: ({ projectId, id }: ChatMutationInput) =>
        setPinnedMutation({ projectId, id, pinned: false }),
      archiveChat: ({ projectId, id }: ChatMutationInput) =>
        setArchivedMutation({ projectId, id, archived: true }),
      unarchiveChat: ({ projectId, id }: ChatMutationInput) =>
        setArchivedMutation({ projectId, id, archived: false }),
      deleteChat: ({ projectId, id }: ChatMutationInput) =>
        deleteChatMutation({ projectId, id }),
    }),
    [
      deleteChatMutation,
      resumeChatMutation,
      setArchivedMutation,
      setPinnedMutation,
      startChatMutation,
    ],
  );
}
