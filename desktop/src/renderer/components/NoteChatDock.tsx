"use client";

import { useEffect, useMemo, useState } from "react";
import { LoaderCircleIcon, MessageSquareIcon } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import type { Harness } from "@/lib/chat";
import type { ChatRowViewModel } from "@/lib/chats";
import { useChatActions, useChatByLink } from "@/hooks/useChats";
import { ChatComposer } from "@/components/ChatComposer";
import { ChatRow } from "@/components/ChatRow";

// The foot-of-note chat dock — a self-contained feature so the note editor stays
// chat-agnostic. Owns its own link lookup, chat actions, and the launcher →
// composer → linked-row three-way (the locked Notes-chat design):
//   - no chat → a calm launcher pill;
//   - clicking it expands the shared ChatComposer in place, prefilled
//     "I need your help in <note path> " with the caret after the text;
//   - a linked chat → the shared ChatRow bar.
// One chat per note: `linkedChat` (resolved via the by_link index, so it holds
// even for an idle chat off the recent window) wins the three-way; archiving or
// deleting it (linkedChat → null) returns to the launcher, never the composer.
//
// Rendered keyed-per-note (its parent NoteEditor is `key={slug}`), so `composing`
// resets when you switch notes.
export function NoteChatDock({
  projectId,
  notePath,
}: {
  projectId: Id<"projects">;
  // The note's index.md path (notes/<slug>/index.md) — both the link key and the
  // composer prefill target.
  notePath: string;
}) {
  const linkedChat = useChatByLink(projectId, "note", notePath);
  const actions = useChatActions();
  const [composing, setComposing] = useState(false);
  // A start mutation is in flight or awaiting bind. startChat no longer creates a
  // pending row, so `linkedChat` stays null through the whole launch→bind window;
  // without this the composer would sit open and let a second chat fire on the
  // same note. We collapse the composer the moment the mutation resolves and show
  // a calm "Starting…" until the daemon binds and `linkedChat` appears.
  const [starting, setStarting] = useState(false);

  // Once the started chat lands, drop out of composing/starting; keeping them
  // false means a later archive/delete (linkedChat → null) returns to the
  // launcher.
  useEffect(() => {
    if (linkedChat) {
      setComposing(false);
      setStarting(false);
    }
  }, [linkedChat]);

  // Resume/pin/archive/delete for the docked ChatRow. One error policy:
  // every action is fire-and-forget (resume legitimately throws for a chat
  // that's still pending; the rest rarely throw — all are swallowed uniformly).
  const rowHandlers = useMemo(() => {
    const fire = (p: Promise<unknown> | unknown) =>
      void Promise.resolve(p).catch(() => {});
    return {
      onResume: (chat: ChatRowViewModel) =>
        fire(actions.resumeChat({ projectId, id: chat.id })),
      onPin: (chat: ChatRowViewModel) =>
        fire(actions.pinChat({ projectId, id: chat.id })),
      onUnpin: (chat: ChatRowViewModel) =>
        fire(actions.unpinChat({ projectId, id: chat.id })),
      onArchive: (chat: ChatRowViewModel) =>
        fire(actions.archiveChat({ projectId, id: chat.id })),
      onUnarchive: (chat: ChatRowViewModel) =>
        fire(actions.unarchiveChat({ projectId, id: chat.id })),
      onDelete: (chat: ChatRowViewModel) =>
        fire(actions.deleteChat({ projectId, id: chat.id })),
    };
  }, [actions, projectId]);

  // Same startChat the TaskDialog uses: linkedType "note" + the
  // note's index.md path, default naming (no title), project cwd resolved by the
  // daemon (no cwd). The collapse effect swaps to the ChatRow when the chat lands.
  async function startNoteChat(params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) {
    setStarting(true);
    try {
      await actions.startChat({
        projectId,
        harness: params.harness,
        initialPrompt: params.prompt,
        model: params.model,
        effort: params.effort,
        linkedType: "note",
        linkedPath: notePath,
      });
      // Collapse now, not on `linkedChat` — the bind can be seconds away and the
      // open composer must not linger as a second-launch trap.
      setComposing(false);
    } catch (err) {
      // The launch never left — reopen for a retry.
      setStarting(false);
      throw err;
    }
  }

  if (linkedChat) {
    return (
      <div className="w-full">
        <ChatRow chat={linkedChat} {...rowHandlers} />
      </div>
    );
  }
  if (composing) {
    return (
      <div className="w-full">
        <ChatComposer
          defaultPrompt={`I need your help in ${notePath} `}
          label={null}
          wide
          onStart={startNoteChat}
        />
      </div>
    );
  }
  // Launch fired, awaiting the daemon's bind — a calm placeholder, never the
  // launcher (which would invite a duplicate chat on this note).
  if (starting) {
    return (
      <div className="flex w-full items-center gap-2 px-1 text-[13px] text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
        Starting…
      </div>
    );
  }
  // Still resolving the link — don't offer the launcher yet, or a fast click
  // could start a second chat on a note that already owns one.
  if (linkedChat === undefined) return null;
  return <NoteLauncher onLaunch={() => setComposing(true)} />;
}

// The resting foot of a note with no chat linked: a calm pill that expands the
// composer above in place (no modal, no navigation).
function NoteLauncher({ onLaunch }: { onLaunch: () => void }) {
  return (
    <button
      type="button"
      onClick={onLaunch}
      className="group inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3.5 py-2 text-[13px] text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
    >
      <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground/80 group-hover:text-foreground">
        Chat with or edit this note
      </span>
    </button>
  );
}
