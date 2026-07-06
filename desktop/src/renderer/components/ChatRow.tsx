"use client";

import type { MouseEvent } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUpRight,
  CornerDownLeftIcon,
  EllipsisIcon,
  PinIcon,
  PinOffIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import type { Harness } from "@/lib/chat";
import type { ChatRowViewModel } from "@/lib/chats";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

// Relative "last activity" stamp for chat rows. Recent (sub-hour) activity reads
// bare ("2m") so a live chat feels current; older activity trails "ago". Mirrors
// the Notes index stamp but with the chat designs' thresholds (days run to 13
// before flipping to weeks, so "9d ago" stays days, "2w ago" is the first week).
function relativeChatTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < min) return "now";
  if (diff < hour) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 14 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 8 * week) return `${Math.floor(diff / week)}w ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// The harness brand mark in a soft rounded tile — the row's leading slot. The
// brand-colored SVG (terracotta Claude Code / blue Codex) is the only color on
// the row; everything else is monochrome (see the PRD's locked decisions).
function ChatHarnessAvatar({ harness }: { harness: Harness }) {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
      <HarnessIcon harness={harness} className="size-5" />
    </div>
  );
}

// `(● )state · time` — the amber dot appears only while running (working), the
// one sanctioned color accent. Everything else stays muted/monochrome.
function ChatStatusLine({
  chat,
  archived,
}: {
  chat: ChatRowViewModel;
  archived?: boolean;
}) {
  const label = archived ? "archived" : chat.statusLabel;
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      {!archived && chat.running && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-[#F59E0B]"
          aria-hidden
        />
      )}
      <span className="truncate">
        {label} · {relativeChatTime(chat.sortTime)}
      </span>
    </span>
  );
}

// One chat row: a bordered card whose whole surface resumes the chat (opens out
// to the harness). On hover/focus it fills light-gray and reveals plain
// "Resume ↗" text — no button border, since the row itself is the target. A
// pending chat (just started, not yet bound to a real session) can't resume yet,
// so its row is inert until the daemon binds it. Exported so the note foot can
// dock the identical bar over a note's linked chat.
export function ChatRow({
  chat,
  archived,
  onResume,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  chat: ChatRowViewModel;
  archived?: boolean;
  onResume: (chat: ChatRowViewModel) => void;
  onPin: (chat: ChatRowViewModel) => void;
  onUnpin: (chat: ChatRowViewModel) => void;
  onArchive: (chat: ChatRowViewModel) => void;
  onUnarchive: (chat: ChatRowViewModel) => void;
  onDelete: (chat: ChatRowViewModel) => void;
}) {
  const resumable = !chat.pending && chat.resumeKind === "open-chat-command";

  function resume() {
    if (resumable) onResume(chat);
  }

  const togglePin = () => (chat.pinned ? onUnpin(chat) : onPin(chat));
  const toggleArchive = () =>
    chat.archived ? onUnarchive(chat) : onArchive(chat);
  const runMenuAction = (event: MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          role="button"
          tabIndex={resumable ? 0 : -1}
          aria-label={`Resume ${chat.title}`}
          onClick={resume}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            const target = e.target as HTMLElement | null;
            if (target?.closest("[data-chat-row-actions]")) return;
            e.preventDefault();
            resume();
          }}
          className={cn(
            "group flex items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3 transition-colors",
            resumable && "cursor-pointer hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            archived && "opacity-55 hover:opacity-100",
          )}
        >
          <ChatHarnessAvatar harness={chat.harness} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              {chat.title}
            </span>
            <ChatStatusLine chat={chat} archived={archived} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {resumable && (
              <span className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                Resume
                <ArrowUpRight className="size-3.5" />
              </span>
            )}
            {chat.pinned && !archived && (
              <PinIcon className="size-3.5 text-muted-foreground" aria-label="Pinned" />
            )}
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Actions for ${chat.title}`}
                    data-chat-row-actions
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                  />
                }
              >
                <EllipsisIcon className="size-4" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  disabled={!resumable}
                  onClick={(event) => runMenuAction(event, resume)}
                >
                  <SquareTerminalIcon />
                  Resume chat
                  <CornerDownLeftIcon className="ml-auto size-3.5 text-muted-foreground" />
                </MenuItem>
                <MenuItem onClick={(event) => runMenuAction(event, togglePin)}>
                  {chat.pinned ? <PinOffIcon /> : <PinIcon />}
                  {chat.pinned ? "Unpin chat" : "Pin chat"}
                </MenuItem>
                <div className="my-1 h-px bg-border" />
                <MenuItem onClick={(event) => runMenuAction(event, toggleArchive)}>
                  {chat.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {chat.archived ? "Unarchive" : "Archive"}
                </MenuItem>
                <MenuItem
                  onClick={(event) => runMenuAction(event, () => onDelete(chat))}
                  className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
                >
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!resumable}
          onClick={(event) => runMenuAction(event, resume)}
        >
          <SquareTerminalIcon />
          Resume chat
          <CornerDownLeftIcon className="ml-auto size-3.5 text-muted-foreground" />
        </ContextMenuItem>
        <ContextMenuItem onClick={(event) => runMenuAction(event, togglePin)}>
          {chat.pinned ? <PinOffIcon /> : <PinIcon />}
          {chat.pinned ? "Unpin chat" : "Pin chat"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={(event) => runMenuAction(event, toggleArchive)}>
          {chat.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {chat.archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onClick={(event) => runMenuAction(event, () => onDelete(chat))}
        >
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
