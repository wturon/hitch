"use client";

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  chatRowViewModel,
  chatsHistoryData,
  chatsHomeData,
  type ChatLinkedType,
  type ChatMutationInput,
  type ChatRowViewModel,
  type ChatsHistoryData,
  type ChatsHomeData,
  type StartChatInput,
} from "@/lib/chats";

export interface ChatQueryOptions {
  search?: string;
  deviceToken?: string;
}

export interface ChatsHomeOptions extends ChatQueryOptions {
  pinnedLimit?: number;
  recentLimit?: number;
}

export interface ChatsHistoryOptions extends ChatQueryOptions {
  limit?: number;
  archivedLimit?: number;
}

export interface ChatsHomeState {
  loading: boolean;
  data: ChatsHomeData | null;
}

export interface ChatsHistoryState {
  loading: boolean;
  data: ChatsHistoryData | null;
}

export interface ChatRecordState {
  loading: boolean;
  chat: ChatRowViewModel | null;
}

function cleanSearch(search: string | undefined) {
  const value = search?.trim();
  return value ? value : undefined;
}

export function useChatsHome(
  projectId: Id<"projects"> | null | undefined,
  options: ChatsHomeOptions = {},
): ChatsHomeState {
  const search = cleanSearch(options.search);
  const result = useQuery(
    api.chats.listHome,
    projectId
      ? {
          projectId,
          ...(search ? { search } : {}),
          ...(options.pinnedLimit ? { pinnedLimit: options.pinnedLimit } : {}),
          ...(options.recentLimit ? { recentLimit: options.recentLimit } : {}),
          ...(options.deviceToken ? { deviceToken: options.deviceToken } : {}),
        }
      : "skip",
  );

  return useMemo(
    () => ({
      loading: projectId !== null && projectId !== undefined && result === undefined,
      data: result ? chatsHomeData(result) : null,
    }),
    [projectId, result],
  );
}

export function useChatsHistory(
  projectId: Id<"projects"> | null | undefined,
  options: ChatsHistoryOptions = {},
): ChatsHistoryState {
  const search = cleanSearch(options.search);
  const result = useQuery(
    api.chats.listHistory,
    projectId
      ? {
          projectId,
          ...(search ? { search } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.archivedLimit
            ? { archivedLimit: options.archivedLimit }
            : {}),
          ...(options.deviceToken ? { deviceToken: options.deviceToken } : {}),
        }
      : "skip",
  );

  return useMemo(
    () => ({
      loading: projectId !== null && projectId !== undefined && result === undefined,
      data: result ? chatsHistoryData(result) : null,
    }),
    [projectId, result],
  );
}

export function useChatRecord(
  projectId: Id<"projects"> | null | undefined,
  id: Id<"chats"> | null | undefined,
  options: Pick<ChatQueryOptions, "deviceToken"> = {},
): ChatRecordState {
  const result = useQuery(
    api.chats.getChat,
    projectId && id
      ? {
          projectId,
          id,
          ...(options.deviceToken ? { deviceToken: options.deviceToken } : {}),
        }
      : "skip",
  );

  return useMemo(
    () => ({
      loading:
        projectId !== null &&
        projectId !== undefined &&
        id !== null &&
        id !== undefined &&
        result === undefined,
      chat: result ? chatRowViewModel(result) : null,
    }),
    [id, projectId, result],
  );
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
