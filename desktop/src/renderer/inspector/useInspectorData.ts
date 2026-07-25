import { useQuery } from "@tanstack/react-query";

import type { HitchClient } from "@/lib/server/client";

// The Inspector's ENTIRE data path: three server reads, nothing else.
// docs/chat-tracking-redesign.md §9 — "under this architecture it is a pure
// server read". No IPC, no SQLite, no second source of truth. If a future
// change needs a fact the server doesn't have, the fix is on the server.
//
// Keys are the coarse per-table keys from lib/server/queryKeys.ts, so the
// main-held WS already invalidates all of this: a `chats` or `chat_events`
// NOTIFY maps to ["chats"] (and TanStack matches by prefix, which is what
// carries the per-chat event tail below), and `machines` maps to ["machines"].
// The snapshot PUT touches both tables every tick, so the window refreshes
// itself with no polling.

export function useInspectorChats(client: HitchClient) {
  return useQuery({
    queryKey: ["chats"],
    queryFn: async () => {
      const response = await client.chats.$get({ query: {} });
      if (!response.ok) throw new Error(`Failed to list chats (${response.status})`);
      return await response.json();
    },
  });
}

export function useInspectorMachines(client: HitchClient) {
  return useQuery({
    queryKey: ["machines"],
    queryFn: async () => {
      const response = await client.machines.$get();
      if (!response.ok) throw new Error(`Failed to list machines (${response.status})`);
      return await response.json();
    },
  });
}

/** The relayed hook-event tail for the drawer's chat. Lazy: only the open row pays. */
export function useChatEvents(client: HitchClient, chatId: string | null) {
  return useQuery({
    queryKey: ["chats", chatId, "events"],
    queryFn: async () => {
      const response = await client.chats[":id"].events.$get({
        param: { id: chatId! },
        query: {},
      });
      if (!response.ok) throw new Error(`Failed to list chat events (${response.status})`);
      return await response.json();
    },
    enabled: chatId !== null,
  });
}

export type InspectorChatRow = NonNullable<ReturnType<typeof useInspectorChats>["data"]>[number];
export type InspectorMachineRow = NonNullable<
  ReturnType<typeof useInspectorMachines>["data"]
>[number];
export type InspectorEventRow = NonNullable<ReturnType<typeof useChatEvents>["data"]>[number];
