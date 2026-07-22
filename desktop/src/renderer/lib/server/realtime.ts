import type { QueryClient } from "@tanstack/react-query";
import type { WsInvalidateMessage } from "@hitch/shared";

import type { HitchServerBridge } from "./bridge";
import { queryKeyForTable } from "./queryKeys";

// Frames arrive as `unknown` over the preload channel; narrow them against the
// shared wire type before acting. Event frames (type:"event") are ignored here
// — they're the ephemeral relay, not cache invalidation (M4 consumes those).
function asInvalidate(message: unknown): WsInvalidateMessage | null {
  if (typeof message !== "object" || message === null) return null;
  const candidate = message as { type?: unknown; table?: unknown };
  if (candidate.type !== "invalidate" || typeof candidate.table !== "string") {
    return null;
  }
  return message as WsInvalidateMessage;
}

/**
 * Wires the main-held WS into the query cache: every invalidation frame maps
 * to its coarse per-table key, and every (re)connect invalidates EVERYTHING —
 * messages missed while disconnected are harmless because reconnect refetches
 * the world (PRD "Realtime"). Returns an unsubscribe for both listeners.
 */
export function startRealtimeInvalidation(
  queryClient: QueryClient,
  bridge: HitchServerBridge,
): () => void {
  const offMessage = bridge.onWsMessage((message) => {
    const invalidate = asInvalidate(message);
    if (!invalidate) return;
    const queryKey = queryKeyForTable(invalidate.table);
    if (!queryKey) return;
    void queryClient.invalidateQueries({ queryKey });
  });
  const offOpen = bridge.onWsOpen(() => {
    void queryClient.invalidateQueries();
  });
  return () => {
    offMessage();
    offOpen();
  };
}
