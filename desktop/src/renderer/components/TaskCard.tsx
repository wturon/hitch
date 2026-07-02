"use client";

import type { Id } from "@convex/_generated/dataModel";
import type {
  ChatOpenState,
  ChatRef,
  ChatStatus,
  DelegationRequest,
} from "@/lib/chat";
import { HarnessChip, RequestChip } from "@/components/HarnessChip";

// A board card models one task body (tasks/<slug>/task.md). The same shape backs
// the kanban board and the note-foot linked-task card, so it lives here next to
// the card visuals rather than in App.
export interface Card {
  id: string; // `tasks/${slug}` — the task folder
  slug: string;
  title: string;
  owner?: string;
  path: string; // tasks/<slug>/task.md — what the dialog writes back
  content: string; // raw file text
  chat: ChatRef | null; // the coding-agent chat driving this task, if linked
  chatStatus: ChatStatus | null; // live working/ready state, if the chat reports it
  chatOpenState: ChatOpenState | null; // whether the chat link is safe to open
  request: DelegationRequest | null; // the pre-link summoning flag (requested/failed)
  column: string;
  archived: boolean;
  updatedAt: number;
}

// Shared card chrome, also reused by the drag overlay so the floating element
// matches the one in the column.
export const CARD_CLASS =
  "rounded-sm bg-card p-3 text-left shadow-[0_1px_1px_rgba(0,0,0,0.03)] ring-[0.75px] ring-border/70";

export function CardSummary({ card }: { card: Card }) {
  return (
    <p className="text-[13px] font-normal text-card-foreground">{card.title}</p>
  );
}

export function CardChat({
  card,
  projectId,
}: {
  card: Card;
  projectId: Id<"projects">;
}) {
  // A bound chat wins; otherwise show the summoning flag if one is in flight or
  // failed. Both render at the card's corner in the same slot.
  if (card.chat) {
    return (
      <div className="mt-3">
        <HarnessChip
          chat={card.chat}
          status={card.chatStatus}
          openState={card.chatOpenState}
          projectId={projectId}
        />
      </div>
    );
  }
  if (card.request) {
    return (
      <div className="mt-3">
        <RequestChip request={card.request} />
      </div>
    );
  }
  return null;
}

export function CardContents({
  card,
  projectId,
}: {
  card: Card;
  projectId: Id<"projects">;
}) {
  return (
    <>
      <CardSummary card={card} />
      {(card.chat || card.request) && (
        <CardChat card={card} projectId={projectId} />
      )}
    </>
  );
}
