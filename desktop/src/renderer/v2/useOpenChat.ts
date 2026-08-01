import { useCallback } from "react";

import { getHitchServerBridge } from "@/lib/server/bridge";
import { chatIsFocusable } from "./chatLane";

// Bring an assignment's chat forward, wherever it's running.
//
// This is the EPHEMERAL half of the PRD's two-forms realtime model: a focus
// event, not a stored command. client → main-held WS → server relay → the
// daemon hello'd for that machine → cmux openChat + activateApp. Fire and
// forget by design — nobody listening means the event evaporates, and the ~30s
// reconcile never touches focus. There is nothing to retry and nothing to ack.
//
// Lifted out of DelegateBar (M4 PR 6) when the todo row's harness chip became
// the second caller: both surfaces mean the same thing by "open the chat", so
// they route through one function rather than two copies of the payload shape.
//
// `canOpen` is false in two different situations, and the hook owns BOTH so no
// caller can render a control that quietly does nothing:
//
//   • no chat yet — chatId is written at spawn, and until then cmux has nothing
//     to focus. Transient; the caller says "Starting…".
//   • no handle — the chat exists and is fully observable, but Hitch didn't
//     launch it (every LINKED chat, and any chat the daemon merely discovered),
//     so the focus relay has nothing to drive. Permanent for that chat.
//
// The second case is why `handle` is part of the target rather than a check each
// caller remembers to add: the todo row's chip shipped without it and spent a
// release offering "Open chat" on chats it could never open.
export interface OpenChatTarget {
  chatId: string | null;
  machineId: string | null;
  /**
   * The chat's `handle`, when known. OMIT it (or pass undefined) when the caller
   * hasn't read the chat row — unknown stays openable. `null` is the server
   * saying there is no handle, and is the only value that disables.
   */
  handle?: unknown;
}

export function useOpenChat(target: OpenChatTarget | null | undefined) {
  const chatId = target?.chatId ?? null;
  const machineId = target?.machineId ?? null;
  const focusable = chatIsFocusable(target?.handle);
  const canOpen = chatId !== null && machineId !== null && focusable;

  const openChat = useCallback(() => {
    if (chatId === null || machineId === null) return;
    void getHitchServerBridge()?.wsSend({
      type: "event",
      event: "focus",
      machineId,
      payload: { chatId },
    });
  }, [chatId, machineId]);

  return {
    canOpen,
    /**
     * Why `canOpen` is false, so callers can word the difference between "not
     * yet" and "not ever". `null` when it's true.
     */
    blockedBy: canOpen ? null : !focusable ? ("no-handle" as const) : ("not-started" as const),
    openChat,
  };
}
