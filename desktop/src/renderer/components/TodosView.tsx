"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  TagIcon,
  Trash2Icon,
  Unlink2Icon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { clearChatFields, parseChatOpenState } from "@/lib/chat";
import {
  parseFrontmatter,
  serializeTagsValue,
  setFrontmatterKeys,
} from "@/lib/frontmatter";
import { taskSlug } from "@/lib/tasks";
import type { TagColorName } from "@/lib/tagColors";
import {
  ensureRegistryTag,
  parseTagRegistry,
  registryColorMap,
  serializeTagRegistry,
  TAG_REGISTRY_PATH,
  type TagRegistry,
} from "@/lib/tagRegistry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  allGroupTodos,
  deriveTodoGroups,
  EMPTY_TAG_FILTER,
  filterTodoGroups,
  indexChats,
  isTagFilterActive,
  reorderBacklog,
  tagFacetCounts,
  type FileRow,
  type TagFilter,
  type Todo,
  type TodoGroups,
} from "@/lib/todos";
import { loadTagFilter, saveTagFilter } from "@/lib/tagFilterStorage";
import { TagPillGroup } from "@/components/tags/TagPill";
import { TagCombobox } from "@/components/tags/TagCombobox";
import { TagFilterBar } from "@/components/tags/TagFilterBar";
import { HarnessChip, RequestChip } from "@/components/HarnessChip";
import { useListKeyboardNav } from "@/hooks/useListKeyboardNav";
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

// Keyboard-nav highlight wiring, supplied only for rows that take part in ↑↓
// navigation (TodosView's flat nav list). Absent → the row isn't navigable
// (e.g. collapsed DONE overflow) — it stays clickable, just not arrow-reachable.
type RowNav = {
  selected: boolean;
  itemProps: {
    "data-idx": number;
    "aria-selected": boolean;
    onMouseMove: () => void;
  };
};

// Tag wiring shared by every row: how to color a tag id (registry-driven, gray
// fallback), the registry's known ids (the assign submenu's option list), and
// the two write actions. Toggling assigns/unassigns the tag in the task's
// frontmatter; creating also registers a color for a brand-new id.
type RowTagProps = {
  colorOf: (id: string) => TagColorName;
  registryTagIds: string[];
  onToggleTag: (todo: Todo, id: string) => void;
  onCreateTag: (todo: Todo, id: string) => void;
};

// The row's right-click Tags ▸ submenu: a searchable combobox that toggles the
// registry's tags on/off for this task and creates+assigns a new one when the
// query matches nothing (board C). Options = registry tags ∪ the task's own tags
// (so an agent-added, unregistered tag can still be toggled off here).
function TagsSubmenu({
  todo,
  tag,
}: {
  todo: Todo;
  tag: RowTagProps;
}) {
  const optionIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of [...tag.registryTagIds, ...todo.tags]) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }, [tag.registryTagIds, todo.tags]);
  const options = optionIds.map((id) => ({ id, color: tag.colorOf(id) }));
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <TagIcon />
        Tags
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="p-0">
        <TagCombobox
          mode="assign"
          options={options}
          selected={new Set(todo.tags)}
          onToggle={(id) => tag.onToggleTag(todo, id)}
          onCreate={(id) => tag.onCreateTag(todo, id)}
          placeholder="Search or create tag…"
        />
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function TodoRow({
  todo,
  variant,
  projectId,
  onOpen,
  onToggleCompleted,
  onArchiveTodo,
  onWriteTodo,
  onDeleteTodo,
  tag,
  drag,
  nav,
}: {
  todo: Todo;
  variant: RowVariant;
  projectId: Id<"projects">;
  onOpen: (path: string) => void;
  onToggleCompleted: (todo: Todo, completed: boolean) => void;
  onArchiveTodo: (todo: Todo) => void;
  // The right-click menu's write/delete actions, threaded from App (Archive and
  // Detach are frontmatter writes; Delete removes the file) — the same handlers
  // the TodoDialog's ⋯ menu uses, so a row's options match the open dialog's.
  onWriteTodo: (path: string, content: string) => void;
  onDeleteTodo: (slug: string) => void;
  // Tag pills + the right-click Tags submenu (assignment).
  tag: RowTagProps;
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
  // Keyboard-nav highlight + data-idx/aria-selected/hover wiring, when this row
  // is part of the ↑↓ list.
  nav?: RowNav;
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
  const archive = () => onArchiveTodo(todo);
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
          {...nav?.itemProps}
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
            // Keyboard highlight. Hover sets the same selection (onMouseMove), so
            // mouse and keyboard converge on one highlighted row.
            nav?.selected && "bg-muted",
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
          <TagPillGroup
            tags={todo.tags}
            colorOf={tag.colorOf}
            dimmed={done}
          />
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
        <TagsSubmenu todo={todo} tag={tag} />
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
  onArchiveTodo,
  onWriteTodo,
  onDeleteTodo,
  tag,
  nav,
}: {
  todo: Todo;
  projectId: Id<"projects">;
  onOpen: (path: string) => void;
  onToggleCompleted: (todo: Todo, completed: boolean) => void;
  onArchiveTodo: (todo: Todo) => void;
  onWriteTodo: (path: string, content: string) => void;
  onDeleteTodo: (slug: string) => void;
  tag: RowTagProps;
  nav?: RowNav;
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
      onArchiveTodo={onArchiveTodo}
      onWriteTodo={onWriteTodo}
      onDeleteTodo={onDeleteTodo}
      tag={tag}
      nav={nav}
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
function AddTodoRow({ onAdd, nav }: { onAdd: () => void; nav?: RowNav }) {
  return (
    <button
      type="button"
      {...nav?.itemProps}
      onClick={onAdd}
      className={cn(
        "group flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
        nav?.selected && "bg-muted",
      )}
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
  active,
  onOpenTodo,
  onAddTodo,
  onToggleCompleted,
  onArchiveTodo,
  onWriteTodo,
  onDeleteTodo,
}: {
  projectId: Id<"projects">;
  files: FileRow[];
  // Whether the Todos surface is live for keyboard nav — false while a dialog
  // (an open todo, the capture card) is up, so ↑↓/↵ don't fire underneath it.
  active: boolean;
  onOpenTodo: (path: string) => void;
  onAddTodo: () => void;
  onToggleCompleted: (todo: Todo, completed: boolean) => void;
  onArchiveTodo: (todo: Todo) => void;
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
  // The tag color registry (tasks/config.json) rides the same `files`
  // subscription as everything else — advisory, colors-only. A missing/blank
  // file parses to the empty registry; a tag not listed here renders gray.
  const registry: TagRegistry = useMemo(() => {
    const file = files.find(
      (f) => f.path === TAG_REGISTRY_PATH && !f.deleted,
    );
    return parseTagRegistry(file?.content);
  }, [files]);
  const colorMap = useMemo(() => registryColorMap(registry), [registry]);
  const colorOf = (id: string): TagColorName => colorMap.get(id) ?? "gray";
  const registryTagIds = useMemo(
    () => registry.tags.map((t) => t.id),
    [registry],
  );

  // View-local tag filter (AND semantics), persisted per project in
  // localStorage. Reload it whenever the project changes so switching projects
  // restores that project's own filter rather than leaking the previous one.
  const [filter, setFilter] = useState<TagFilter>(() =>
    loadTagFilter(projectId),
  );
  useEffect(() => {
    setFilter(loadTagFilter(projectId));
  }, [projectId]);
  const updateFilter = (next: TagFilter) => {
    setFilter(next);
    saveTagFilter(projectId, next);
  };
  // Selecting a tag clears Untagged and vice versa (untagged ∧ tag is empty).
  const toggleFilterTag = (id: string) => {
    const has = filter.tags.includes(id);
    updateFilter({
      untagged: false,
      tags: has ? filter.tags.filter((t) => t !== id) : [...filter.tags, id],
    });
  };
  const toggleFilterUntagged = () => {
    updateFilter({ tags: [], untagged: !filter.untagged });
  };
  const clearFilter = () => updateFilter(EMPTY_TAG_FILTER);
  const filterActive = isTagFilterActive(filter);

  // Assignment writes flow through the SAME optimistic file-upsert path as every
  // other row edit (onWriteTodo), so the pill reflects instantly. Registry
  // writes hit that path too (config.json is just another synced file). We read
  // `todo.content` fresh from the live query each time — no local fork.
  const toggleTag = (todo: Todo, id: string) => {
    const has = todo.tags.includes(id);
    const nextTags = has
      ? todo.tags.filter((t) => t !== id)
      : [...todo.tags, id];
    onWriteTodo(
      todo.path,
      setFrontmatterKeys(todo.content, { tags: serializeTagsValue(nextTags) }),
    );
  };
  const createTag = (todo: Todo, id: string) => {
    if (!todo.tags.includes(id)) {
      onWriteTodo(
        todo.path,
        setFrontmatterKeys(todo.content, {
          tags: serializeTagsValue([...todo.tags, id]),
        }),
      );
    }
    // Register a rotation color for a brand-new id (no-op if already present).
    const { registry: next, changed } = ensureRegistryTag(registry, id);
    if (changed) {
      onWriteTodo(TAG_REGISTRY_PATH, serializeTagRegistry(next));
    }
  };
  const rowTag: RowTagProps = {
    colorOf,
    registryTagIds,
    onToggleTag: toggleTag,
    onCreateTag: createTag,
  };

  // Derive once (unfiltered) for the facet counts + the truly-empty check, then
  // project through the active filter for what actually renders.
  const allGroups: TodoGroups = deriveTodoGroups(files, order, chats);
  const groups: TodoGroups = filterTodoGroups(allGroups, filter);

  const universe = useMemo(() => allGroupTodos(allGroups), [allGroups]);
  const facetCounts = useMemo(
    () => tagFacetCounts(universe, filter),
    [universe, filter],
  );
  // Filter options = registry tags ∪ any tag actually present on a task (so an
  // agent-added, unregistered tag is still filterable), registry order first.
  const filterOptions = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of registryTagIds) {
      if (!seen.has(id)) (seen.add(id), ids.push(id));
    }
    const extra: string[] = [];
    for (const t of universe)
      for (const id of t.tags)
        if (!seen.has(id)) (seen.add(id), extra.push(id));
    extra.sort();
    return [...ids, ...extra].map((id) => ({ id, color: colorOf(id) }));
  }, [registryTagIds, universe, colorMap]);
  const hasAnyTags = filterOptions.length > 0;

  const isEmpty =
    allGroups.needsYou.length +
      allGroups.working.length +
      allGroups.backlog.length +
      allGroups.done.length ===
    0;
  // Filtered down to nothing (distinct from an empty project).
  const noFilterMatches =
    filterActive &&
    groups.needsYou.length +
      groups.working.length +
      groups.backlog.length +
      groups.done.length ===
      0;

  const doneVisible = showAllDone
    ? groups.done
    : groups.done.slice(0, DONE_PREVIEW);
  const hiddenDone = groups.done.length - doneVisible.length;

  // The flat ↑↓ order = every VISIBLE row, top-to-bottom, matching render order.
  // The BACKLOG add affordance is a real navigable item between WORKING and the
  // backlog rows; collapsed DONE rows are deliberately out because they are not
  // shown. Paths are unique, so a path→index map drives each task row highlight
  // without threading a running counter through the JSX.
  const scrollRef = useRef<HTMLDivElement>(null);
  const navItems = useMemo(
    () =>
      [
        ...groups.needsYou.map((todo) => ({ kind: "todo" as const, todo })),
        ...groups.working.map((todo) => ({ kind: "todo" as const, todo })),
        // The capture affordance is hidden while a filter is active, so it drops
        // out of the ↑↓ order too.
        ...(filterActive ? [] : [{ kind: "add" as const }]),
        ...groups.backlog.map((todo) => ({ kind: "todo" as const, todo })),
        ...doneVisible.map((todo) => ({ kind: "todo" as const, todo })),
      ],
    [groups.needsYou, groups.working, groups.backlog, doneVisible, filterActive],
  );
  const navIndexByPath = useMemo(
    () =>
      new Map(
        navItems.flatMap((item, i) =>
          item.kind === "todo" ? ([[item.todo.path, i]] as const) : [],
        ),
      ),
    [navItems],
  );
  const { selected, itemProps } = useListKeyboardNav({
    count: navItems.length,
    active,
    containerRef: scrollRef,
    onActivate: (i) => {
      const item = navItems[i];
      if (!item) return;
      if (item.kind === "add") onAddTodo();
      else onOpenTodo(item.todo.path);
    },
  });
  // Per-row highlight wiring, or undefined for rows outside the nav list.
  const rowNav = (path: string): RowNav | undefined => {
    const i = navIndexByPath.get(path);
    if (i === undefined) return undefined;
    return { selected: selected === i, itemProps: itemProps(i) };
  };
  const addNavIndex = navItems.findIndex((item) => item.kind === "add");
  const addNav: RowNav | undefined =
    addNavIndex === -1
      ? undefined
      : { selected: selected === addNavIndex, itemProps: itemProps(addNavIndex) };

  const rowProps = {
    projectId,
    onOpen: onOpenTodo,
    onToggleCompleted,
    onArchiveTodo,
    onWriteTodo,
    onDeleteTodo,
    tag: rowTag,
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
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 pt-7 pb-16">
        {(hasAnyTags || filterActive) && (
          <TagFilterBar
            options={filterOptions}
            filter={filter}
            counts={facetCounts}
            colorOf={colorOf}
            onToggleTag={toggleFilterTag}
            onToggleUntagged={toggleFilterUntagged}
            onClear={clearFilter}
          />
        )}

        {groups.needsYou.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="NEEDS YOU" amber />
            {groups.needsYou.map((todo) => (
              <TodoRow
                key={todo.path}
                todo={todo}
                variant="needs-you"
                nav={rowNav(todo.path)}
                {...rowProps}
              />
            ))}
          </section>
        )}

        {groups.working.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="WORKING" />
            {groups.working.map((todo) => (
              <TodoRow
                key={todo.path}
                todo={todo}
                variant="working"
                nav={rowNav(todo.path)}
                {...rowProps}
              />
            ))}
          </section>
        )}

        {/* BACKLOG. Unfiltered it always shows — it hosts the capture
            affordance, so its header never vanishes. While a filter is active
            the capture row and drag-reorder are hidden (the visible order is a
            filtered projection; writing backlogOrders from it would corrupt the
            real order), and the whole section collapses when nothing matches. */}
        {filterActive ? (
          groups.backlog.length > 0 && (
            <section className="flex flex-col">
              <GroupHeader label="BACKLOG" />
              {groups.backlog.map((todo) => (
                <TodoRow
                  key={todo.path}
                  todo={todo}
                  variant="backlog"
                  nav={rowNav(todo.path)}
                  {...rowProps}
                />
              ))}
            </section>
          )
        ) : (
          <section className="flex flex-col">
            <GroupHeader label="BACKLOG" />
            <AddTodoRow onAdd={onAddTodo} nav={addNav} />
            <DndContext sensors={sensors} onDragEnd={onBacklogDragEnd}>
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
                    onArchiveTodo={onArchiveTodo}
                    onWriteTodo={onWriteTodo}
                    onDeleteTodo={onDeleteTodo}
                    tag={rowTag}
                    nav={rowNav(todo.path)}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {isEmpty && <EmptyHint />}
          </section>
        )}

        {noFilterMatches && (
          <p className="px-2.5 py-8 text-center text-[13px] text-muted-foreground">
            No todos match this filter.
          </p>
        )}

        {groups.done.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="DONE" />
            {doneVisible.map((todo) => (
              <TodoRow
                key={todo.path}
                todo={todo}
                variant="done"
                nav={rowNav(todo.path)}
                {...rowProps}
              />
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
