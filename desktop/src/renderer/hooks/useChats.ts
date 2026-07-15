"use client";

import { useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { ChatMutationInput, StartChatInput } from "@/lib/chats";

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
