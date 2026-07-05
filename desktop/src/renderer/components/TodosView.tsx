"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArchiveIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleIcon,
  CopyIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  Unlink2Icon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { clearChatFields, parseChatOpenState } from "@/lib/chat";
import { parseFrontmatter, setFrontmatterKeys } from "@/lib/frontmatter";
import { taskSlug } from "@/lib/tasks";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  deriveTodoGroups,
  indexChats,
  reorderBacklog,
  type FileRow,
  type Todo,
  type TodoGroups,
} from "@/lib/todos";
import { HarnessChip, RequestChip } from "@/components/HarnessChip";
import { cn } from "@/lib/utils";

// How many completed todos the collapsed DONE group previews before the
// "Show N more completed" toggle. The artboard shows a small recent slice; the
// exact count isn't load-bearing — DONE is meant to stay tucked away.
const DONE_PREVIEW = 3;

// A compact "last activity" stamp for the NEEDS YOU subtitle. Sub-hour reads
// bare ("4m"), older trails "ago" — matching the Chats index cadence.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 14 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// The one color moment in the app: NEEDS YOU wears an amber small-caps header;
// every other group header is quiet neutral. The trailing hairline picks up the
// same tone.
function GroupHeader({ label, amber }: { label: string; amber?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5">
      <span
        className={cn(
          "text-[11px] font-medium uppercase leading-[14px] tracking-[0.05em]",
          amber
            ? "text-amber-700 dark:text-amber-500/90"
            : "text-neutral-400 dark:text-neutral-500",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "h-px flex-1",
          amber ? "bg-amber-500/35" : "bg-border",
        )}
        aria-hidden
      />
    </div>
  );
}

// Checkbox on every row, always visible, never displaced by agent state — the
// one manual gesture. Checking sets `completed-at`; unchecking clears it.
function TodoCheckbox({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Mark not done" : "Mark done"}
      // Keep the tap on the checkbox from arming the row's drag sensor.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-lg border-[1.5px] transition-colors",
        checked
          ? "border-neutral-700 bg-neutral-700 text-white dark:border-neutral-300 dark:bg-neutral-300 dark:text-neutral-900"
          : "border-[#BEBEBE] hover:border-neutral-400 dark:border-neutral-600 dark:hover:border-neutral-500",
      )}
    >
      {checked && <CheckIcon className="size-2.5" strokeWidth={4} />}
    </button>
  );
}

// The agent-state affordance, verbatim from the board: a live chat rides the
// HarnessChip (idle ring / spinner / amber needs-input dot), a pre-bind summon
// rides the RequestChip. Done rows ghost it so the chat stays reachable but
// recedes. The row's `group` class drives the chip's expand-on-hover.
function RowChip({
  todo,
  projectId,
  ghost,
}: {
  todo: Todo;
  projectId: Id<"projects">;
  ghost?: boolean;
}) {
  let chip: React.ReactNode = null;
  if (todo.request) {
    chip = <RequestChip request={todo.request} />;
  } else if (todo.chat) {
    const { frontmatter } = parseFrontmatter(todo.content);
    chip = (
      <HarnessChip
        chat={todo.chat}
        status={todo.chatStatus}
        openState={parseChatOpenState(frontmatter)}
        projectId={projectId}
      />
    );
  }
  if (!chip) return <span className="w-6 shrink-0" aria-hidden />;
  return (
    <span
      // The chip opens the linked chat; keep its pointerdown from arming a drag.
      onPointerDown={(e) => e.stopPropagation()}
      className={cn("flex shrink-0 justify-end", ghost && "opacity-35")}
    >
      {chip}
    </span>
  );
}

type RowVariant = "needs-you" | "working" | "backlog" | "done";

function TodoRow({
  todo,
  variant,
  projectId,
  onOpen,
  onToggleCompleted,
  onWriteTodo,
  onDeleteTodo,
  drag,
}: {
  todo: Todo;
  variant: RowVariant;
  projectId: Id<"projects">;
  onOpen: (path: string) => void;
  onToggleCompleted: (todo: Todo, completed: boolean) => void;
  // The right-click menu's write/delete actions, threaded from App (Archive and
  // Detach are frontmatter writes; Delete removes the file) — the same handlers
  // the TodoDialog's ⋯ menu uses, so a row's options match the open dialog's.
  onWriteTodo: (path: string, content: string) => void;
  onDeleteTodo: (slug: string) => void;
  // Present only for BACKLOG rows, which are drag-reorderable. Wires dnd-kit's
  // sortable node/transform onto the whole row (whole-row drag, like the board's
  // cards) while the checkbox / chip / row-click stay live — interactive
  // children stop pointerdown so a drag can't start from them, and PointerSensor's
  // activation distance lets a plain click through to open.
  drag?: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: CSSProperties;
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown> | undefined;
    dragging: boolean;
  };
}) {
  const done = variant === "done";
  // A requested (pre-bind) row folds into WORKING extra-ghosted; a bound working
  // row is merely dimmed. Backlog/needs-you stay full-contrast.
  const ghostTitle = variant === "working" && todo.request !== null;
  const twoLine = variant === "needs-you";
  const recency = todo.chatRecency ?? todo.updatedAt;
  const subtitle = twoLine
    ? `${todo.chatStatus === "needs-input" ? "Needs your input" : "Waiting for you"} · ${relativeTime(recency)}`
    : null;

  // The right-click menu's options, mirroring the TodoDialog ⋯ menu (SavedActions)
  // plus the row-native primaries (Open / Mark done). Detach only shows when
  // there's a chat or request to strip; Delete needs a resolvable slug.
  const canDetach = todo.chat !== null || todo.request !== null;
  const slug = taskSlug(todo.path);
  const copyPath = () =>
    void navigator.clipboard.writeText(todo.path).catch(() => {});
  const archive = () =>
    onWriteTodo(
      todo.path,
      setFrontmatterKeys(todo.content, {
        "archived-at": new Date().toISOString(),
      }),
    );
  const detach = () => onWriteTodo(todo.path, clearChatFields(todo.content));
  const del = () => {
    if (slug) onDeleteTodo(slug);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          ref={drag?.setNodeRef}
          style={drag?.style}
          {...drag?.attributes}
          {...drag?.listeners}
          role="button"
          tabIndex={0}
          aria-label={todo.title}
          onClick={() => onOpen(todo.path)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('[role="checkbox"],button')) return;
            e.preventDefault();
            onOpen(todo.path);
          }}
          className={cn(
            "group flex cursor-pointer items-center gap-3 rounded-lg px-2.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
            twoLine ? "min-h-[54px] py-1.5" : "h-[42px]",
            // A dragged backlog row lifts subtly — opaque over its neighbours, a
            // hair of shadow — no new chrome, no handle. Quiet.
            drag?.dragging &&
              "relative z-10 bg-background shadow-sm ring-1 ring-border/70",
          )}
        >
          <TodoCheckbox
            checked={done}
            onToggle={() => onToggleCompleted(todo, !done)}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-[13.5px] leading-[18px]",
                variant === "needs-you" && "font-medium text-foreground",
                variant === "backlog" && "text-foreground",
                variant === "working" &&
                  (ghostTitle
                    ? "text-muted-foreground/70"
                    : "text-muted-foreground"),
                done &&
                  "text-neutral-400 line-through decoration-1 dark:text-neutral-500",
              )}
            >
              {todo.title}
            </span>
            {subtitle && (
              <span className="truncate text-[12px] leading-4 text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
          <RowChip todo={todo} projectId={projectId} ghost={done} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onOpen(todo.path)}>
          <SquareArrowOutUpRightIcon />
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onToggleCompleted(todo, !done)}>
          {done ? <CircleIcon /> : <CircleCheckIcon />}
          {done ? "Mark not done" : "Mark done"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={copyPath}>
          <CopyIcon />
          Copy task path
        </ContextMenuItem>
        {canDetach && (
          <ContextMenuItem onClick={detach}>
            <Unlink2Icon />
            Detach chat
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={archive}>
          <ArchiveIcon />
          Archive
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={del}>
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A BACKLOG row wrapped in dnd-kit sortable wiring so the group can be manually
// reordered (Decision "The list": backlog is the one group with manual order).
// Mirrors AppSidebar's SortablePinnedRow — whole-row drag, transform/transition
// handed to TodoRow's root. Keyed by the task path (its sortable id).
function SortableTodoRow({
  todo,
  projectId,
  onOpen,
  onToggleCompleted,
  onWriteTodo,
  onDeleteTodo,
}: {
  todo: Todo;
  projectId: Id<"projects">;
  onOpen: (path: string) => void;
  onToggleCompleted: (todo: Todo, completed: boolean) => void;
  onWriteTodo: (path: string, content: string) => void;
  onDeleteTodo: (slug: string) => void;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } =
    useSortable({ id: todo.path });
  return (
    <TodoRow
      todo={todo}
      variant="backlog"
      projectId={projectId}
      onOpen={onOpen}
      onToggleCompleted={onToggleCompleted}
      onWriteTodo={onWriteTodo}
      onDeleteTodo={onDeleteTodo}
      drag={{
        setNodeRef,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
        },
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: listeners as unknown as Record<string, unknown> | undefined,
        dragging: isDragging,
      }}
    />
  );
}

// The quiet, borderless capture affordance pinned to the top of BACKLOG. Opens
// the existing create dialog (the two-stage capture card is slice 4). The "C"
// hint mirrors the global capture shortcut already wired in App.
function AddTodoRow({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className="group flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-muted/60"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <PlusIcon
          className="size-3 text-neutral-400 dark:text-neutral-500"
          strokeWidth={2}
        />
      </span>
      <span className="flex-1 text-[13.5px] leading-[18px] text-neutral-400 dark:text-neutral-500">
        Add a todo…
      </span>
      <kbd className="font-mono text-[10.5px] text-neutral-300 dark:text-neutral-600">
        C
      </kbd>
    </button>
  );
}

// The empty-project state: BACKLOG header + add-row + a soft illustration. Shown
// only when every group is empty (JCT-0).
function EmptyHint() {
  return (
    <div className="mt-16 flex flex-col items-center gap-3 text-center">
      <svg
        width="52"
        height="52"
        viewBox="0 0 52 52"
        fill="none"
        aria-hidden
        className="text-neutral-300 dark:text-neutral-600"
      >
        <rect
          x="9"
          y="9"
          width="22"
          height="22"
          rx="5"
          stroke="currentColor"
          strokeWidth="2"
        />
        <rect
          x="20"
          y="20"
          width="22"
          height="22"
          rx="5"
          fill="var(--color-background)"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M45 8l1.2 3.3L49.5 12.5 46.2 13.7 45 17l-1.2-3.3L40.5 12.5 43.8 11.3z"
          fill="currentColor"
        />
      </svg>
      <span className="text-[13px] text-muted-foreground">Add your first todo</span>
    </div>
  );
}

// The Todos tab: the project's tasks grouped by attention (NEEDS YOU / WORKING /
// BACKLOG / DONE), derived — no columns, no manual statuses. Rows bubble between
// groups automatically from their linked chat's state; checking off is the one
// manual gesture. Reads the manual Backlog order from Convex and hands it to the
// pure derivation, which reconciles stale/unlisted paths at read time.
export function TodosView({
  projectId,
  files,
  onOpenTodo,
  onAddTodo,
  onToggleCompleted,
  onWriteTodo,
  onDeleteTodo,
}: {
  projectId: Id<"projects">;
  files: FileRow[];
  onOpenTodo: (path: string) => void;
  onAddTodo: () => void;
  onToggleCompleted: (todo: Todo, completed: boolean) => void;
  // Row context-menu writes (Archive/Detach) and delete — the same App-level
  // handlers the TodoDialog uses, so a row's right-click options stay in sync
  // with the open dialog's ⋯ menu.
  onWriteTodo: (path: string, content: string) => void;
  onDeleteTodo: (slug: string) => void;
}) {
  const [showAllDone, setShowAllDone] = useState(false);
  const order = useQuery(api.backlogOrders.getBacklogOrder, { projectId }) ?? [];

  // Whole-list-replace mutation with an optimistic update: the drop reflects
  // instantly by patching the cached getBacklogOrder before the round trip, so
  // the list doesn't flicker while the mutation flies (same pattern the sidebar
  // uses for pin reordering). `args.order` IS the next full ordered list, so
  // the derivation re-runs against it directly.
  const setBacklogOrder = useMutation(
    api.backlogOrders.setBacklogOrder,
  ).withOptimisticUpdate((store, args) => {
    store.setQuery(
      api.backlogOrders.getBacklogOrder,
      { projectId: args.projectId },
      args.order,
    );
  });

  // A small activation distance keeps a plain click (open the todo / toggle the
  // checkbox) from being read as a drag — matching the sidebar's sortable list.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // The live-chat rows backing the derivation's index-supplied mode
  // (chats.listForTodos is deliberately complete — see its comment; a truncated
  // feed would misgroup working chats into NEEDS YOU).
  const chatRows = useQuery(api.chats.listForTodos, { projectId });
  // LOADING GUARD (load-bearing, non-obvious): while the subscription is still
  // undefined, derive WITHOUT the index (frontmatter coexistence mode) — NOT
  // with an empty map. Under slice 1's index-supplied semantics an empty map
  // means "every chat-id is a dead chat", which would flash every working todo
  // into NEEDS YOU for a frame. Only once rows arrive does the live index
  // become authoritative.
  const chats = useMemo(
    () => (chatRows === undefined ? undefined : indexChats(chatRows)),
    [chatRows],
  );
  const groups: TodoGroups = deriveTodoGroups(files, order, chats);

  const isEmpty =
    groups.needsYou.length +
      groups.working.length +
      groups.backlog.length +
      groups.done.length ===
    0;

  const doneVisible = showAllDone
    ? groups.done
    : groups.done.slice(0, DONE_PREVIEW);
  const hiddenDone = groups.done.length - doneVisible.length;

  const rowProps = {
    projectId,
    onOpen: onOpenTodo,
    onToggleCompleted,
    onWriteTodo,
    onDeleteTodo,
  };

  // The sortable ids = the currently-shown backlog paths in rendered order
  // (sortBacklog has already interleaved ordered rows + updatedAt-desc absentees).
  const backlogPaths = groups.backlog.map((t) => t.path);

  function onBacklogDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = backlogPaths.indexOf(String(active.id));
    const to = backlogPaths.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    // Persist the WHOLE currently-shown list, reordered — a full replace. This
    // pins every shown row (including absentees) and naturally drops any stale
    // path from the stored order (opportunistic compaction), since backlogPaths
    // only contains present paths.
    void setBacklogOrder({
      projectId,
      order: reorderBacklog(backlogPaths, from, to),
    });
  }

  return (
    <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto sm:-mx-6 lg:-mx-8">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 pt-7 pb-16">
        {groups.needsYou.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="NEEDS YOU" amber />
            {groups.needsYou.map((todo) => (
              <TodoRow key={todo.path} todo={todo} variant="needs-you" {...rowProps} />
            ))}
          </section>
        )}

        {groups.working.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="WORKING" />
            {groups.working.map((todo) => (
              <TodoRow key={todo.path} todo={todo} variant="working" {...rowProps} />
            ))}
          </section>
        )}

        {/* BACKLOG always shows — it hosts the capture affordance, so its header
            never vanishes (unlike the other groups). */}
        <section className="flex flex-col">
          <GroupHeader label="BACKLOG" />
          <AddTodoRow onAdd={onAddTodo} />
          <DndContext
            sensors={sensors}
            onDragEnd={onBacklogDragEnd}
          >
            <SortableContext
              items={backlogPaths}
              strategy={verticalListSortingStrategy}
            >
              {groups.backlog.map((todo) => (
                <SortableTodoRow
                  key={todo.path}
                  todo={todo}
                  projectId={projectId}
                  onOpen={onOpenTodo}
                  onToggleCompleted={onToggleCompleted}
                  onWriteTodo={onWriteTodo}
                  onDeleteTodo={onDeleteTodo}
                />
              ))}
            </SortableContext>
          </DndContext>
          {isEmpty && <EmptyHint />}
        </section>

        {groups.done.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="DONE" />
            {doneVisible.map((todo) => (
              <TodoRow key={todo.path} todo={todo} variant="done" {...rowProps} />
            ))}
            {(hiddenDone > 0 || showAllDone) && (
              <button
                type="button"
                onClick={() => setShowAllDone((v) => !v)}
                className="w-fit pl-[38px] pt-1.5 text-left text-[12px] leading-4 text-muted-foreground hover:text-foreground"
              >
                {showAllDone
                  ? "Show less"
                  : `Show ${hiddenDone} more completed`}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
