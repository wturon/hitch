"use client";

import {
  AlignLeftIcon,
  ArchiveIcon,
  CodeIcon,
  CopyIcon,
  EllipsisIcon,
  Trash2Icon,
  Unlink2Icon,
  XIcon,
} from "lucide-react";

import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";

// The saved-stage top-right chrome: the ⋯ overflow menu (Raw markdown · Copy
// task path · Detach chat · Archive · Delete — the existing-todo menu, L-menu
// artboard) and the ✕. Rendered above the title, never sharing its line (KRN-0).
// Capture is chrome-free, so the shell mounts this only in the saved stage.
// `onDetach` is present only when a chat is linked OR a request exists (nothing
// to detach otherwise); it strips every chat-* frontmatter key (including the
// request flag) so the todo derives back to Backlog.
export function SavedActions({
  view,
  onToggleView,
  onCopyPath,
  onDetach,
  onArchive,
  onDelete,
  onClose,
}: {
  view: "raw" | "formatted";
  onToggleView: () => void;
  onCopyPath: () => void;
  onDetach?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1">
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Todo actions"
              className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onClick={onToggleView}>
            {view === "raw" ? <AlignLeftIcon /> : <CodeIcon />}
            {view === "raw" ? "Formatted view" : "Raw markdown"}
          </MenuItem>
          <MenuItem onClick={onCopyPath}>
            <CopyIcon />
            Copy task path
          </MenuItem>
          <div className="my-1 h-px bg-border" />
          {onDetach && (
            <MenuItem onClick={onDetach}>
              <Unlink2Icon />
              Detach chat
            </MenuItem>
          )}
          <MenuItem onClick={onArchive}>
            <ArchiveIcon />
            Archive
          </MenuItem>
          <div className="my-1 h-px bg-border" />
          <MenuItem
            onClick={onDelete}
            className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
          >
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
