"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

import type { ChatRef } from "@/lib/chat";
import type { CmuxAccessReason } from "@/components/CmuxAccessDialog";

// Shared "jump back to the chat" behavior used by every launcher surface (the
// labeled ChatLaunch button and the board's corner HarnessChip). It enqueues an
// open command for the local daemon so each harness can honor the user's
// preferred environment, then watches how the daemon resolved it so callers can
// guide the user through the tricky outcomes:
//   - cmux refusing the connection (a guided access dialog)
//   - T3Code focus degrading to a reveal/unavailable hint (Hitch didn't launch
//     the app, so it can only surface the window).
// Returns plain state + actions; callers own all the UI (button, dialog, hint).
export function useOpenChat(chat: ChatRef, projectId: Id<"projects">) {
  const enqueue = useMutation(api.commands.enqueueCommand);
  const [opening, setOpening] = useState(false);
  // Watch the launch command we just enqueued so we can react to how the daemon
  // resolved it — chiefly to guide the user when cmux refuses the connection.
  const [pendingCommandId, setPendingCommandId] =
    useState<Id<"commands"> | null>(null);
  const [cmuxReason, setCmuxReason] = useState<CmuxAccessReason | null>(null);
  // T3Code focus degrades when Hitch didn't launch the app (it can only reveal
  // the window). The daemon's t3code reopen reports this via the command result
  // ("revealed"/"unavailable"); no other launcher returns those values.
  const [focusHint, setFocusHint] = useState<string | null>(null);
  const command = useQuery(
    api.commands.getCommand,
    pendingCommandId ? { id: pendingCommandId, projectId } : "skip",
  );

  useEffect(() => {
    if (!command || command.status === "pending") return;
    // Terminal: stop watching. Open the guided dialog for the cmux failures we
    // recognize; other outcomes (done, or an unrecognized error) just clear.
    setPendingCommandId(null);
    if (
      command.status === "error" &&
      (command.errorCode === "cmux-access-denied" ||
        command.errorCode === "cmux-unavailable")
    ) {
      setCmuxReason(command.errorCode);
    }
    if (command.status === "done" && command.result === "revealed") {
      setFocusHint(
        "T3Code is open but wasn't launched by Hitch, so we can't jump to this thread automatically. Click the thread in T3Code's sidebar, or relaunch T3Code from Hitch to enable one-click focus.",
      );
    } else if (command.status === "done" && command.result === "unavailable") {
      setFocusHint(
        "Couldn't reach T3Code. Make sure it's installed and its environment is initialized, then try again.",
      );
    }
  }, [command]);

  async function launchOpen() {
    setOpening(true);
    setFocusHint(null);
    try {
      const id = await enqueue({
        projectId,
        kind: "open-chat",
        harness: chat.harness,
        sessionId: chat.id,
        cwd: chat.cwd,
      });
      setPendingCommandId(id);
    } finally {
      setTimeout(() => setOpening(false), 1500);
    }
  }

  return {
    opening,
    launchOpen,
    cmuxReason,
    setCmuxReason,
    focusHint,
    setFocusHint,
  };
}
