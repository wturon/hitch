"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { parseFrontmatter, setFrontmatterKeys } from "@/lib/frontmatter";
import {
  parseChatRef,
  parseChatStatus,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { sha256 } from "@/lib/hash";
import { taskBodyPath, taskSlug, uniqueSlug } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { TaskDialog, type TaskTarget } from "@/components/TaskDialog";
import { ChatLaunch } from "@/components/ChatLaunch";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

// The workspace this board renders. Matches `workspace` in ../hitch.config.json
// (the daemon pushes files under this id). Hard-coded for now; later this comes
// from routing / a workspace picker.
const WORKSPACE = "will-default";

// localStorage key remembering the source the composer last wrote into, so the
// picker defaults to it across reloads.
const LAST_SOURCE_KEY = "hitch:last-source";

// Columns the board shows, in order. Any task whose `status` frontmatter
// doesn't match one of these falls into "todo". Legacy `blocked` cards land in
// review so old files don't disappear from the expected workflow.
const COLUMNS = ["todo", "in-progress", "review", "done"] as const;
type Column = (typeof COLUMNS)[number];

function columnFor(status: string | undefined): Column {
  const s = (status ?? "").toLowerCase();
  if (s === "blocked") return "review";
  return (COLUMNS as readonly string[]).includes(s) ? (s as Column) : "todo";
}

interface Card {
  id: string; // `${source}/tasks/${slug}` — the task folder
  slug: string;
  title: string;
  owner?: string;
  source: string;
  path: string; // tasks/<slug>/task.md — what the dialog writes back
  content: string; // raw file text
  chat: ChatRef | null; // the coding-agent chat driving this task, if linked
  chatStatus: ChatStatus | null; // live working/ready state, if the chat reports it
  column: Column;
  archived: boolean;
  updatedAt: number;
}

// Shared card chrome, also reused by the drag overlay so the floating element
// matches the one in the column.
const CARD_CLASS =
  "rounded-lg bg-card p-3 text-left shadow-sm ring-1 ring-border";

function CardContents({ card }: { card: Card }) {
  return (
    <>
      <p className="text-sm font-medium text-card-foreground">{card.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {card.owner ? `${card.owner} · ` : ""}
        {card.source}
      </p>
      {card.chat && (
        <div className="mt-2">
          <ChatLaunch
            chat={card.chat}
            status={card.chatStatus}
            workspace={WORKSPACE}
            size="xs"
            stopPropagation
          />
        </div>
      )}
    </>
  );
}

// The hover-revealed archive shortcut in a card's top-right corner. Clicking it
// once arms a confirmation (the icon becomes an "Archive" pill); clicking the
// pill archives. `onPointerDown`/`onClick` stop propagation so the button drives
// neither the card's drag (PointerSensor listeners live on the card) nor its
// open-on-click. Only rendered for unarchived cards — restoring stays in the
// context menu.
function stopCardPropagation(e: React.PointerEvent | React.MouseEvent) {
  e.stopPropagation();
}

function ArchiveShortcut({
  confirming,
  pending,
  onArm,
  onConfirm,
}: {
  confirming: boolean;
  pending: boolean;
  onArm: () => void;
  onConfirm: () => void;
}) {
  if (confirming) {
    return (
      <button
        type="button"
        disabled={pending}
        aria-label="Confirm archive"
        onPointerDown={stopCardPropagation}
        onClick={(e) => {
          stopCardPropagation(e);
          onConfirm();
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground shadow-sm ring-1 ring-border hover:bg-foreground hover:text-background"
      >
        <ArchiveIcon className="size-3" />
        Confirm
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={pending}
            aria-label="Archive"
            onPointerDown={stopCardPropagation}
            onClick={(e) => {
              stopCardPropagation(e);
              onArm();
            }}
            className="absolute right-2 top-2 hidden rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground group-hover:block focus-visible:block focus-visible:outline-none"
          />
        }
      >
        <ArchiveIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>Archive</TooltipContent>
    </Tooltip>
  );
}

interface DraggableCardProps {
  card: Card;
  pending: boolean;
  onOpen: (card: Card) => void;
  onArchiveToggle: (card: Card, archived: boolean) => void;
  onDelete: (card: Card) => void;
}

// A board card that can be picked up (left-drag, 5px threshold so a plain click
// still opens it) and dropped on another column. Right-click keeps the existing
// archive/delete menu — PointerSensor ignores non-primary buttons, so the menu
// and dragging don't fight. Defined at module scope (not inside Board) so it
// isn't a fresh component type each render, which would remount mid-drag.
function DraggableCard({
  card,
  pending,
  onOpen,
  onArchiveToggle,
  onDelete,
}: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
  });
  // Whether the hover archive shortcut has been clicked once and is now showing
  // its "Archive" confirmation pill. Reset when the pointer leaves the card so a
  // half-armed card doesn't stay armed.
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onMouseLeave={() => setConfirmingArchive(false)}
          className={cn(
            CARD_CLASS,
            "group relative cursor-pointer transition-shadow hover:ring-foreground/20",
            isDragging && "opacity-40",
          )}
        >
          <button
            type="button"
            onClick={() => onOpen(card)}
            className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CardContents card={card} />
          </button>
          {!card.archived && (
            <ArchiveShortcut
              confirming={confirmingArchive}
              pending={pending}
              onArm={() => setConfirmingArchive(true)}
              onConfirm={() => {
                setConfirmingArchive(false);
                onArchiveToggle(card, true);
              }}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={pending}
          onClick={() => onArchiveToggle(card, !card.archived)}
        >
          {card.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {card.archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={pending}
          variant="destructive"
          onClick={() => onDelete(card)}
        >
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A single row in the archived sheet: the task's title/source plus inline
// unarchive and delete actions. Kept compact (one row per task) since the sheet
// is a management surface, not the board — there's no drag or open-on-click.
function ArchivedRow({
  card,
  pending,
  onUnarchive,
  onDelete,
}: {
  card: Card;
  pending: boolean;
  onUnarchive: (card: Card) => void;
  onDelete: (card: Card) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-card p-3 ring-1 ring-border">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-card-foreground">
          {card.title}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {card.owner ? `${card.owner} · ` : ""}
          {card.source}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => onUnarchive(card)}
      >
        <ArchiveRestoreIcon />
        Unarchive
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        className="text-muted-foreground hover:text-destructive"
        onClick={() => onDelete(card)}
      >
        <Trash2Icon />
        Delete
      </Button>
    </div>
  );
}

// The side sheet listing every archived task with per-row unarchive/delete and
// a "Delete all" action in the header. Replaces the old bottom-of-board archived
// grouping. "Delete all" arms a confirmation on first click (it's irreversible)
// and confirms on the second; the armed state resets whenever the sheet closes.
function ArchivedSheet({
  open,
  onOpenChange,
  cards,
  pendingCardId,
  onUnarchive,
  onDelete,
  onDeleteAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: Card[];
  pendingCardId: string | null;
  onUnarchive: (card: Card) => void;
  onDelete: (card: Card) => void;
  onDeleteAll: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <ArchivedSheetContent
        key={open ? "open" : "closed"}
        cards={cards}
        pendingCardId={pendingCardId}
        onUnarchive={onUnarchive}
        onDelete={onDelete}
        onDeleteAll={onDeleteAll}
      />
    </Sheet>
  );
}

function ArchivedSheetContent({
  cards,
  pendingCardId,
  onUnarchive,
  onDelete,
  onDeleteAll,
}: {
  cards: Card[];
  pendingCardId: string | null;
  onUnarchive: (card: Card) => void;
  onDelete: (card: Card) => void;
  onDeleteAll: () => void;
}) {
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  return (
    <SheetContent className="gap-0">
      <SheetHeader>
        <SheetTitle>Archived</SheetTitle>
        <SheetDescription>
          {cards.length} archived task{cards.length === 1 ? "" : "s"}
        </SheetDescription>
        {cards.length > 0 && (
          <Button
            variant={confirmingDeleteAll ? "destructive" : "outline"}
            size="sm"
            className="mt-2 w-fit"
            onClick={() => {
              if (confirmingDeleteAll) {
                onDeleteAll();
                setConfirmingDeleteAll(false);
              } else {
                setConfirmingDeleteAll(true);
              }
            }}
          >
            <Trash2Icon />
            {confirmingDeleteAll
              ? `Delete all ${cards.length}? Click to confirm`
              : "Delete all"}
          </Button>
        )}
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing archived.</p>
        ) : (
          cards.map((card) => (
            <ArchivedRow
              key={card.id}
              card={card}
              pending={pendingCardId === card.id}
              onUnarchive={onUnarchive}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </SheetContent>
  );
}

// The inline "new task" input that appears at the top of a column. Commit is a
// single path — blur — so Enter and clicking away both save; Escape sets a guard
// so its blur discards instead. An empty/whitespace title creates nothing.
//
// Below the title sits a Todoist-style source picker: the task's `source` is the
// watched root it's written into (→ storage key + the agent's cwd when a chat is
// launched), so picking it here is how a multi-project board chooses a project.
// The picker only renders when there's more than one source to choose between.
function TaskComposer({
  onCreate,
  onClose,
  sources,
  source,
  onSourceChange,
}: {
  onCreate: (title: string) => void;
  onClose: () => void;
  sources: string[];
  source: string;
  onSourceChange: (source: string) => void;
}) {
  const [value, setValue] = useState("");
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The picker steals focus from the input; this guard keeps the input's blur
  // from committing/closing while the user is choosing a source.
  const interacting = useRef(false);

  function commit() {
    const title = value.trim();
    if (title) onCreate(title);
    onClose();
  }

  return (
    <div className={cn(CARD_CLASS, "flex flex-col gap-2 bg-card")}>
      <input
        aria-label="Task title"
        ref={inputRef}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (interacting.current) return;
          if (!cancelled.current) commit();
          else onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            onClose();
          }
        }}
        placeholder="Task title…"
        spellCheck={false}
        className="w-full bg-transparent text-sm font-medium text-card-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />
      {sources.length > 1 && (
        <Menu
          onOpenChange={(open) => {
            interacting.current = open;
          }}
        >
          <MenuTrigger
            onMouseDown={() => {
              interacting.current = true;
            }}
            className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-popup-open:bg-accent"
          >
            <FolderIcon className="size-3" />
            {source}
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuContent align="start">
            {sources.map((s) => (
              <MenuItem
                key={s}
                onClick={() => {
                  onSourceChange(s);
                  // Return focus so Enter still commits after picking.
                  inputRef.current?.focus();
                }}
              >
                <FolderIcon className="size-3 opacity-60" />
                {s}
                {s === source && <CheckIcon className="ml-auto size-3" />}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

// A column that accepts dropped cards. Its droppable id IS the status value, so
// the drop handler can read the destination status straight off `over.id`.
function DroppableColumn({
  col,
  count,
  onAdd,
  children,
}: {
  col: Column;
  count: number;
  onAdd: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "relative flex flex-col gap-3 rounded-xl bg-muted p-3 transition-colors",
        isOver && "ring-2 ring-ring",
      )}
    >
      <div className="relative z-20 flex items-center justify-between px-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {col} · {count}
        </h2>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onAdd}
                aria-label="Add task"
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipContent>add task… (C)</TooltipContent>
        </Tooltip>
      </div>
      {children}
      {count === 0 && <p className="px-1 text-xs text-muted-foreground/70">No tasks</p>}

      {/* While a card is hovering this column, fade its cards and explain that
          drop position isn't user-controlled — the board sorts by last update,
          so there's no "drop here" slot the way a manually-ordered board has. */}
      {isOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-muted/70 backdrop-blur-[1px]">
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">
              Ordered by last updated
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Drop anywhere to move here
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Board() {
  const files = useQuery(api.files.listFiles, { workspace: WORKSPACE });
  const daemons = useQuery(api.status.listDaemons, { workspace: WORKSPACE });
  // Optimistically patch the cached file so a drag/archive/delete — and a brand
  // new task — reflects instantly instead of waiting on the frontmatter →
  // daemon → Convex round trip. Bumping updatedAt lands the card at the top of
  // its (destination) column, matching how the server-stamped value will sort
  // once it settles. A create hits the same path: no row matches the key, so we
  // append a fabricated one (real _id arrives when the daemon round-trips).
  const upsertFile = useMutation(api.files.upsertFile).withOptimisticUpdate(
    (localStore, args) => {
      const existing = localStore.getQuery(api.files.listFiles, {
        workspace: args.workspace,
      });
      if (existing === undefined) return;
      type FileDoc = (typeof existing)[number];
      const idx = existing.findIndex(
        (f) => f.source === args.source && f.path === args.path,
      );
      const base: FileDoc =
        idx >= 0
          ? existing[idx]
          : ({
              _id: `optimistic:${args.source}/${args.path}` as FileDoc["_id"],
              _creationTime: Number.MAX_SAFE_INTEGER,
              workspace: args.workspace,
              source: args.source,
              path: args.path,
            } as FileDoc);
      const patched: FileDoc = {
        ...base,
        content: args.content,
        hash: args.hash,
        deleted: args.deleted,
        // Pin to the top of the destination column until the server-stamped
        // updatedAt arrives (which will also be recent).
        updatedAt: Number.MAX_SAFE_INTEGER,
      };
      const next =
        idx >= 0
          ? existing.map((f, i) => (i === idx ? patched : f))
          : [...existing, patched];
      localStore.setQuery(
        api.files.listFiles,
        { workspace: args.workspace },
        next,
      );
    },
  );
  const [selected, setSelected] = useState<Card | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which column, if any, has its inline "new task" composer open.
  const [composingCol, setComposingCol] = useState<Column | null>(null);
  // The source the composer writes into, Todoist-style "remember my last
  // project". Lazily restored from localStorage; null falls back to the default
  // source. Safe to read here despite SSR — the composer (the only consumer)
  // isn't mounted until the user opens it, so there's no hydration mismatch.
  const [pickedSource, setPickedSource] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(LAST_SOURCE_KEY);
    } catch {
      return null;
    }
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // `C` arms the composer on the first column for keyboard-driven creation.
  // Ignored while typing in a field or with the editor open, and when chorded
  // with a modifier (so browser shortcuts like ⌘C still work).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (selected) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      ) {
        return;
      }
      e.preventDefault();
      setComposingCol(COLUMNS[0]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (files === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Connecting to Convex…
      </main>
    );
  }

  // A card is a task body (tasks/<slug>/task.md). Drop tombstones and any file
  // that isn't a canonical task body; parse frontmatter; bucket by status.
  const cards = files
    .reduce<Card[]>((acc, f) => {
      if (f.deleted) return acc;
      const slug = taskSlug(f.path);
      if (slug === null) return acc;
      const { frontmatter } = parseFrontmatter(f.content);
      const status = frontmatter.status?.toLowerCase();
      acc.push({
        id: `${f.source}/tasks/${slug}`,
        slug,
        title: frontmatter.title || slug,
        owner: frontmatter.owner,
        source: f.source,
        path: f.path,
        content: f.content,
        chat: parseChatRef(frontmatter),
        chatStatus: parseChatStatus(frontmatter),
        column: columnFor(status),
        archived: status === "archived",
        updatedAt: f.updatedAt,
      });
      return acc;
    }, [])
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeCards = cards.filter((card) => !card.archived);
  const archivedCards = cards.filter((card) => card.archived);
  const byColumn = Object.fromEntries(
    COLUMNS.map((c) => [c, activeCards.filter((card) => card.column === c)]),
  ) as Record<Column, Card[]>;

  const target: TaskTarget | null = selected && {
    workspace: WORKSPACE,
    source: selected.source,
    path: selected.path,
    title: selected.title,
    content: selected.content,
  };

  // The sources a web-created task can be written into: every watched root the
  // connected daemons report, unioned with any source already on the board (so
  // a source survives in the picker even if its daemon is momentarily offline).
  const availableSources = Array.from(
    new Set([
      ...(daemons?.flatMap((d) => d.sources) ?? []),
      ...cards.map((c) => c.source),
    ]),
  ).sort();

  // The source the composer will write into. Prefer the user's last pick (kept
  // in `pickedSource`, restored from localStorage) when it's still available;
  // otherwise default to the first source. Null (no daemon, no files) disables
  // creation — we'd have nowhere to put the file.
  const createSource =
    (pickedSource && availableSources.includes(pickedSource)
      ? pickedSource
      : availableSources[0]) ?? null;

  function chooseSource(source: string) {
    setPickedSource(source);
    try {
      localStorage.setItem(LAST_SOURCE_KEY, source);
    } catch {
      // Private mode / disabled storage — picking still works for this session.
    }
  }

  // Create a task by writing a fresh `tasks/<slug>/task.md` through the same
  // upsert path everything else uses; the daemon writes the file and the live
  // query renders the card (instantly, via the optimistic insert above).
  async function createTask(column: Column, title: string, source: string) {
    const taken = new Set<string>();
    for (const card of cards) {
      if (card.source === source) taken.add(card.slug);
    }
    const slug = uniqueSlug(title, taken);
    const content = setFrontmatterKeys("", { title, status: column });
    await upsertFile({
      workspace: WORKSPACE,
      source,
      path: taskBodyPath(slug),
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  async function setArchived(card: Card, archived: boolean) {
    const { frontmatter } = parseFrontmatter(card.content);
    const restoreStatus = columnFor(frontmatter.archivedFrom);
    const nextContent = setFrontmatterKeys(card.content, {
      status: archived ? "archived" : restoreStatus,
      archivedFrom: archived ? card.column : undefined,
    });

    setPendingCardId(card.id);
    try {
      await upsertFile({
        workspace: WORKSPACE,
        source: card.source,
        path: card.path,
        content: nextContent,
        hash: await sha256(nextContent),
        deleted: false,
      });
    } finally {
      setPendingCardId(null);
    }
  }

  async function deleteCard(card: Card) {
    setPendingCardId(card.id);
    try {
      await upsertFile({
        workspace: WORKSPACE,
        source: card.source,
        path: card.path,
        content: "",
        hash: "",
        deleted: true,
      });
    } finally {
      setPendingCardId(null);
    }
  }

  // Delete every archived task in one shot. Fires the deletes concurrently
  // through the same tombstone path `deleteCard` uses; the optimistic update
  // drops each card immediately.
  async function deleteAllArchived() {
    await Promise.all(
      archivedCards.map((card) =>
        upsertFile({
          workspace: WORKSPACE,
          source: card.source,
          path: card.path,
          content: "",
          hash: "",
          deleted: true,
        }),
      ),
    );
  }

  // Move a card to another column by rewriting just its `status` frontmatter,
  // through the same save path the dialog and archive use.
  async function setStatus(card: Card, status: Column) {
    const nextContent = setFrontmatterKeys(card.content, { status });

    setPendingCardId(card.id);
    try {
      await upsertFile({
        workspace: WORKSPACE,
        source: card.source,
        path: card.path,
        content: nextContent,
        hash: await sha256(nextContent),
        deleted: false,
      });
    } finally {
      setPendingCardId(null);
    }
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    // Dropping anywhere onto an archived card's origin or the same column is a
    // no-op. `over.id` is always a column id (only columns are droppable).
    const card = cards.find((c) => c.id === active.id);
    const dest = over.id as Column;
    if (!card || (card.column === dest && !card.archived)) return;
    void setStatus(card, dest);
  }

  const activeCard = activeId
    ? (cards.find((c) => c.id === activeId) ?? null)
    : null;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Hitch</h1>
          <span className="text-sm text-muted-foreground">
            {activeCards.length} task
            {activeCards.length === 1 ? "" : "s"} · live
          </span>
        </div>
        {archivedCards.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowArchived(true)}
          >
            <ArchiveIcon />
            Show archived
          </Button>
        )}
      </header>

      <DndContext
        sensors={sensors}
        onDragStart={(event: DragStartEvent) =>
          setActiveId(String(event.active.id))
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((col) => (
            <DroppableColumn
              key={col}
              col={col}
              count={byColumn[col].length}
              onAdd={() => setComposingCol(col)}
            >
              {composingCol === col && createSource && (
                <TaskComposer
                  onCreate={(title) =>
                    void createTask(col, title, createSource)
                  }
                  onClose={() => setComposingCol(null)}
                  sources={availableSources}
                  source={createSource}
                  onSourceChange={chooseSource}
                />
              )}
              {byColumn[col].map((card) => (
                <DraggableCard
                  key={card.id}
                  card={card}
                  pending={pendingCardId === card.id}
                  onOpen={setSelected}
                  onArchiveToggle={(c, archived) => void setArchived(c, archived)}
                  onDelete={(c) => void deleteCard(c)}
                />
              ))}
            </DroppableColumn>
          ))}
        </div>

        {/* dropAnimation={null}: the dragged card's DOM node never leaves its
            origin column (we only dim it), so dnd-kit's default drop animation
            would fly the overlay back to column 1 before the re-rendered card
            appears in its new column. Killing it makes the move read as instant,
            Linear-style. */}
        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <div
              className={cn(
                CARD_CLASS,
                "cursor-grabbing shadow-lg ring-foreground/20",
              )}
            >
              <CardContents card={activeCard} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <ArchivedSheet
        open={showArchived}
        onOpenChange={setShowArchived}
        cards={archivedCards}
        pendingCardId={pendingCardId}
        onUnarchive={(c) => void setArchived(c, false)}
        onDelete={(c) => void deleteCard(c)}
        onDeleteAll={() => void deleteAllArchived()}
      />

      <TaskDialog
        task={target}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </main>
  );
}
