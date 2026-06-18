"use client";

import type { Id } from "@convex/_generated/dataModel";
import { ArchiveIcon, Trash2Icon } from "lucide-react";
import type {
  ChatOpenState,
  ChatRef,
  ChatStatus,
} from "@/lib/chat";
import { HarnessChip } from "@/components/HarnessChip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

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
  // The note this task was launched from (frontmatter `source-note`), if any —
  // a one-way link the note uses to find its task(s). Absent for board tasks.
  sourceNote?: string;
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
  if (!card.chat) return null;

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
      {card.chat && <CardChat card={card} projectId={projectId} />}
    </>
  );
}

// The same board card, docked at the foot of a note it was launched from. No drag
// (it isn't on the board here), but otherwise identical chrome: click → open the
// task dialog, the chip opens/focuses the chat (it stops its own click so the
// card's open never fires), right-click → archive/delete. Archiving or deleting
// leaves no active linked task, so the note foot reverts to its launcher.
export function LinkedTaskCard({
  card,
  projectId,
  onOpen,
  onArchive,
  onDelete,
}: {
  card: Card;
  projectId: Id<"projects">;
  onOpen: (card: Card) => void;
  onArchive: (card: Card) => void;
  onDelete: (card: Card) => void;
}) {
  // A click/Enter on the chip (or any inner control) is its own action — don't
  // also open the task. The chip stops click propagation; this guards keyboard
  // activation and any future inner controls.
  const fromControl = (target: EventTarget | null) =>
    target instanceof Element && target.closest("button, a") !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          role="button"
          tabIndex={0}
          onClick={(event) => {
            if (fromControl(event.target)) return;
            onOpen(card);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (fromControl(event.target)) return;
            event.preventDefault();
            onOpen(card);
          }}
          className={cn(
            CARD_CLASS,
            "group relative cursor-default transition-shadow hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <CardSummary card={card} />
          <CardChat card={card} projectId={projectId} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onArchive(card)}>
          <ArchiveIcon />
          Archive
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onDelete(card)}>
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
