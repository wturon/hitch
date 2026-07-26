import { useCallback } from "react";

import { getHitchServerBridge } from "@/lib/server/bridge";

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
// `canOpen` is false until the daemon has linked a chat (chatId is written at
// spawn), which is also the window where cmux has nothing to focus yet.
export interface OpenChatTarget {
  chatId: string | null;
  machineId: string | null;
}

export function useOpenChat(target: OpenChatTarget | null | undefined) {
  const chatId = target?.chatId ?? null;
  const machineId = target?.machineId ?? null;
  const canOpen = chatId !== null && machineId !== null;

  const openChat = useCallback(() => {
    if (chatId === null || machineId === null) return;
    void getHitchServerBridge()?.wsSend({
      type: "event",
      event: "focus",
      machineId,
      payload: { chatId },
    });
  }, [chatId, machineId]);

  return { canOpen, openChat };
}
