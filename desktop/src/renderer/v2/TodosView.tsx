import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
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
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { TagFilterBar } from "@/components/tags/TagFilterBar";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { useListKeyboardNav } from "@/hooks/useListKeyboardNav";
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import {
  capChipStack,
  COLLAPSED_CHIP_LIMIT,
  liveTaskChips,
  rowChips,
  type RowChips,
} from "./chipStack";
import { StaticHarnessChip } from "./HarnessChip";
// The row and its immediate helpers, extracted so the cross-project "All
// tasks" view renders the SAME row rather than a lookalike. SortableTaskRow
// below stays here: it is this view's drag machinery, not the row's.
import { ROW_CHROME, TaskRow, type RowActions, type RowNav } from "./TaskRow";
import { addSlotId, buildSlots, headerSlotId, placementAfterMove } from "./flatList";
import { sortOrderAtIndex } from "./listMutations";
import { loadCollapsedSections, saveCollapsedSections } from "./sectionCollapse";
import {
  deriveSectionedTasks,
  sortSections,
  type SectionBucket,
} from "./sectionGroups";
import {
  filterSectionedTasks,
  isTagFilterActive,
  loadTagFilter,
  saveTagFilter,
  tagFacetCounts,
  EMPTY_TAG_FILTER,
  type TagFilter,
} from "./tagFilter";
import { chatsByTaskId } from "./todoGroups";
import { useAckAssignment } from "./useAckAssignment";
import { useAllAssignments, useChats } from "./useAssignments";
import { useSections } from "./useSections";
import {
  stepSectionSortOrder,
  useSectionMutations,
  type SectionMutations,
} from "./useSectionMutations";
import type { TagActions } from "./useTagMutations";

// The V2 Todos surface: the selected project's tasks from the Hono server, laid
// out by USER PLACEMENT — loose tasks first, then the project's sections in
// order, DONE collapsed at the bottom (sectionGroups.ts).
//
// Sections v1 replaced the NEEDS YOU / WORKING / BACKLOG attention groups this
// view shipped with. Those made a row's POSITION a function of its agent's
// state, so rows relocated on their own; sections and derived groups are two
// competing vertical axes and only one can win. Status still shows — it moved
// into the row's harness chip (HarnessChip.tsx), which is now the single
// instrument for everything an agent is doing. `deriveTaskGroups` survives in
// todoGroups.ts for DONE ordering and for the ⌘K palette's group labels (App),
// its only remaining consumers.
//
// V1's full row interaction set is unchanged on server rows:
//
//   • checkbox → check/uncheck (unchecking returns the row to the TOP of its
//     own container), optimistic via the shell's useTaskMutations;
//   • whole-row drag reorder, within a container and across them (dnd-kit,
//     single-row PATCH computed between the drop's neighbors);
//   • right-click context menu (V1's structure minus the V1-only entries —
//     copy-agent-prompt replaces V1's filesystem-only copy-path; detach/archive
//     have no V2 counterpart. Tags ▸
//     assign submenu (PR 5), routed through the shell's single
//     useTagMutations instance;
//   • V1's tag filter bar (PR 5): AND-semantics multi-tag filter + exclusive
//     Untagged, facet counts, persisted per project in localStorage
//     (tagFilter.ts). While a filter is active the capture add-row and drag
//     reorder are hidden, exactly like V1 (the visible order is a filtered
//     projection);
//   • V1's keyboard nav: ↑↓ move the highlight (hover arms it too — mouse and
//     keyboard share ONE selection), ↵ opens, ←→ walk the row's controls,
//     `e` toggles done, Backspace/Delete deletes the highlighted row (the
//     hover-arms-delete quirk is accepted V1 behavior, kept on purpose).
//
// All writes flow through the handlers the shell threads down from its single
// useTaskMutations instance, so the list, the dialog ⋯ menu and the shortcuts
// share one code path — and rows in the shell's pending-delete window are
// filtered out here (the optimistic face of delete-with-undo).
//
// V1's TodoRow/GroupHeader aren't exported and are welded to the frontmatter
// Todo model (chat chips, frontmatter writes), so the row chrome here is a
// slim sibling carrying the same classes; TagPillGroup, the context-menu kit
// and useListKeyboardNav ARE the V1 modules, imported.

// Exported so the shell's task-dialog query (App) shares this EXACT queryFn
// under the same key — one cache entry, one live truth for both surfaces.
export async function fetchTasks(client: HitchClient, projectId: string) {
  const response = await client.tasks.$get({ query: { project_id: projectId } });
  if (!response.ok) throw new Error(`Failed to list tasks (${response.status})`);
  return await response.json();
}

export type TaskItem = Awaited<ReturnType<typeof fetchTasks>>[number];

// How many completed tasks the collapsed DONE group previews before the
// "Show N more completed" toggle — same cadence as V1 (DONE stays tucked away).
const DONE_PREVIEW = 3;

// V1's group header, verbatim: 11px small-caps label + trailing hairline. Its
// amber variant went with NEEDS YOU — DONE is the only caller left, and a
// section's own header is a different component (SectionHeader).
function GroupHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5">
      <span className="text-[11px] font-medium uppercase leading-[14px] tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

// A section's header: hanging disclosure caret, the user's name RENDERED AS
// TYPED, its open count, and a hairline underneath. Deliberately quieter than
// the GroupHeader above — that one labels four constants of ours and can shout;
// this one is someone else's words, and uppercasing them is the same category
// of edit as rewriting capture text.
//
// A COLLAPSED section shows the chips of the agents inside it. Collapsing is
// how a long project gets short, and the design fails if collapsing can hide an
// agent that needs you — V2's sidebar has no attention count to fall back on.
// It reuses the chip rather than minting a second status vocabulary.
function SectionHeader({
  name,
  count,
  matching,
  collapsed,
  onToggle,
  onRename,
  menu,
  hiddenChips,
}: {
  name: string;
  /** The section's full open count, ignoring any filter. */
  count: number;
  /** How many survive the active filter; undefined when none is active. */
  matching?: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (next: string) => void;
  /** Given the header's own "start renaming" action, so Rename can live in it. */
  menu: (startRename: () => void) => ReactNode;
  /** Rendered only while collapsed: the live agents this section is hiding. */
  hiddenChips?: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);

  return (
    <div
      data-testid="v2-section-header"
      className="group/section relative flex h-8 items-center gap-2 border-b border-border pr-1 pl-2.5"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        className="absolute -left-3.5 flex size-3.5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
      </button>

      {renaming ? (
        <SectionNameInput
          initial={name}
          onCommit={(next) => {
            setRenaming(false);
            // An unchanged or emptied name is a cancel, not a write: the server
            // rejects an empty name, and there is nothing to say about a rename
            // that renames nothing.
            if (next && next !== name) onRename(next);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <>
          {/* Double-click to rename mirrors every other list app; the ⋯ menu
              carries the discoverable version of the same action. */}
          <span
            className="min-w-0 truncate text-[13.5px] font-semibold leading-5"
            onDoubleClick={() => setRenaming(true)}
          >
            {name}
          </span>
          {count > 0 && (
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
              {/* While filtering, the list is a projection — say so, rather
                  than showing a total that doesn't match the rows under it. */}
              {matching === undefined || matching === count
                ? count
                : `${matching} of ${count}`}
            </span>
          )}
          <span className="flex-1" />
          {collapsed && hiddenChips}
          <span className="pointer-events-none shrink-0 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/section:pointer-events-auto group-hover/section:opacity-100">
            {menu(() => setRenaming(true))}
          </span>
        </>
      )}
    </div>
  );
}

// A section's ⋯ menu. Reorder is one step at a time rather than a drag: a
// project has a handful of sections, and two menu items beat a second drag
// system with its own hit targets and failure modes.
function SectionMenu({
  section,
  index,
  sections,
  taskCount,
  mutations,
  onStartRename,
}: {
  section: { id: string; name: string };
  /** Position in the project's section list, for the step-reorder maths. */
  index: number;
  sections: ReadonlyArray<{ sortOrder: string }>;
  taskCount: number;
  mutations: SectionMutations;
  onStartRename: () => void;
}) {
  const step = (direction: "up" | "down") => {
    const sortOrder = stepSectionSortOrder(sections, index, direction);
    if (sortOrder !== null) mutations.reorderSection(section.id, sortOrder);
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Section options for ${section.name}`}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuContent>
        <MenuItem onClick={onStartRename}>
          <PencilIcon />
          Rename
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={index <= 0} onClick={() => step("up")}>
          <ArrowUpIcon />
          Move up
        </MenuItem>
        <MenuItem
          disabled={index < 0 || index >= sections.length - 1}
          onClick={() => step("down")}
        >
          <ArrowDownIcon />
          Move down
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          // ui/menu has no `variant` prop (ui/context-menu does); same tokens,
          // spelled out.
          className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
          onClick={() => {
            // Deleting a section never deletes work — the FK is
            // `on delete set null` — so the confirm says what happens to the
            // todos rather than asking "are you sure". It does NOT promise a
            // position: DELETE only nulls section_id and leaves sort_order
            // alone, so they rejoin the loose list wherever their keys put
            // them, which is often near the bottom.
            const fate =
              taskCount === 0
                ? ""
                : `\n\nIts ${taskCount} ${taskCount === 1 ? "todo stays" : "todos stay"} in the project, unfiled.`;
            if (window.confirm(`Delete the section “${section.name}”?${fate}`)) {
              mutations.deleteSection(section.id);
            }
          }}
        >
          <Trash2Icon />
          Delete section
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

// The inline name field, shared by rename and by "+ New section" — one set of
// commit rules for both, since they are the same gesture at different ends of
// the list. Enter commits, Escape cancels, blur commits (a click elsewhere is
// not a discard: losing typed text to a stray click is the rudest thing a text
// field can do).
function SectionNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  /** Receives the TRIMMED value; "" means there is nothing to write. */
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  // Escape must not also commit through the blur that follows it.
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label="Section name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (cancelled.current) return;
        onCommit(value.trim());
      }}
      onKeyDown={(e) => {
        // The list's own ↑↓/Backspace/`e` shortcuts must not fire while
        // someone is typing a name into it.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      className="min-w-0 flex-1 bg-transparent text-[13.5px] font-semibold leading-5 outline-none placeholder:font-normal placeholder:text-muted-foreground"
    />
  );
}

// A drop target that can't be picked up: a section's header, and a container's
// add-row. Both sit in the same sortable list as the rows, which is what makes
// an empty section, a collapsed section, and the strip above a section's first
// row all reachable — without a single container droppable, and without a
// second notion of "where the row is" to keep in sync.
//
// Sections are reordered from the ⋯ menu rather than by dragging, so
// `draggable` is off; dnd-kit takes the two halves independently.
function DropSlot({
  id,
  disabled,
  className,
  children,
}: {
  id: string;
  disabled: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id,
    disabled: { draggable: true, droppable: disabled },
  });
  return (
    <div
      ref={setNodeRef}
      className={className}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children}
    </div>
  );
}

// "+ New section" — a quiet affordance between hairlines at the bottom of the
// list, which becomes the name field in place when clicked.
function NewSectionRow({ onCreate }: { onCreate: (name: string) => void }) {
  const [naming, setNaming] = useState(false);
  if (naming) {
    return (
      <div className="mt-4 flex h-8 items-center border-b border-border pl-2.5">
        <SectionNameInput
          initial=""
          placeholder="Section name"
          onCommit={(name) => {
            setNaming(false);
            if (name) onCreate(name);
          }}
          onCancel={() => setNaming(false)}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="v2-new-section"
      onClick={() => setNaming(true)}
      className="mt-4 flex items-center gap-2.5 px-2.5 py-2 text-[12px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/list:opacity-100"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="shrink-0">+ New section</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </button>
  );
}

// A BACKLOG row wrapped in dnd-kit sortable wiring (V1's SortableTodoRow):
// whole-row drag, transform/transition handed to TaskRow's root. Keyed by the
// task id (its sortable id).
function SortableTaskRow({
  task,
  tag,
  actions,
  chip,
  sections,
  nav,
}: {
  task: TaskItem;
  tag: TagActions;
  actions: RowActions;
  chip: RowChips;
  sections: ReadonlyArray<{ id: string; name: string }>;
  nav?: RowNav;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } =
    useSortable({ id: task.id });
  return (
    <TaskRow
      task={task}
      done={false}
      tag={tag}
      actions={actions}
      chip={chip}
      sections={sections}
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

// The quiet, borderless capture affordance pinned to the top of BACKLOG —
// V1's AddTodoRow chrome, now a navigable item in the ↑↓ list (and inert for
// Backspace/`e`, since it's not a task). The `C` hint mirrors the global
// capture shortcut wired in App.
function AddTaskRow({
  onAdd,
  nav,
  // The `C` hint belongs to the GLOBAL capture shortcut, which always lands
  // loose — so only the loose add-row claims it. A section's add-row is the
  // same affordance without the keystroke.
  hint = false,
}: {
  onAdd: () => void;
  nav?: RowNav;
  hint?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="v2-add-task"
      {...nav?.itemProps}
      onClick={onAdd}
      className={cn(
        "flex h-10 w-full items-center gap-3 px-2.5 text-left",
        // The same highlight the task rows use — it is in the ↑↓ order, so it
        // has to light up exactly like its neighbours when the cursor lands.
        ROW_CHROME,
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
      {hint && (
        <kbd className="font-mono text-[10.5px] text-neutral-300 dark:text-neutral-600">
          C
        </kbd>
      )}
    </button>
  );
}

// The agents a COLLAPSED section is hiding, shown in its header.
//
// Collapsing is how a long project gets short, and V2's sidebar carries no
// per-project attention count — so without this, folding a section away can
// silently hide an agent that needs you. Rendered inert (no hover expansion,
// no click target): it is a signal to open the section, not a second way to
// reach the chat.
//
// Capped, because a section with eleven running agents should read as "busy",
// not as eleven circles. `needs-you` sorts ahead of `working` so the one that
// wants a human is never the one that gets truncated (chipStack's
// `liveTaskChips`, which is also where the ONE-PER-TASK rule lives: a folded
// section holding five multi-chat tasks shows five discs, not twenty).
function collapsedChips(
  tasks: TaskItem[],
  chipOf: (taskId: string) => RowChips,
) {
  return liveTaskChips(
    tasks.map((task) => ({ taskId: task.id, chip: chipOf(task.id) })),
  );
}

// Whether any of these tasks has an agent worth telegraphing from a collapsed
// header. Same derivation CollapsedSectionChips renders from, so a section is
// never kept for chips it then declines to draw.
function hasLiveAgent(
  tasks: TaskItem[],
  chipOf: (taskId: string) => RowChips,
): boolean {
  return collapsedChips(tasks, chipOf).length > 0;
}

function CollapsedSectionChips({
  tasks,
  chipOf,
}: {
  tasks: TaskItem[];
  chipOf: (taskId: string) => RowChips;
}) {
  const live = collapsedChips(tasks, chipOf);
  if (live.length === 0) return null;
  const { shown, overflow } = capChipStack(live, COLLAPSED_CHIP_LIMIT);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((entry) => (
        <StaticHarnessChip
          key={entry.taskId}
          harness={entry.harness}
          state={entry.state}
        />
      ))}
      {overflow > 0 && (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          +{overflow}
        </span>
      )}
      <span className="sr-only">
        {live.filter((e) => e.state === "needs-you").length} needing you,{" "}
        {live.filter((e) => e.state === "working").length} working
      </span>
    </span>
  );
}

// V1's empty-project illustration, copied (it isn't exported from TodosView).
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
        <rect x="9" y="9" width="22" height="22" rx="5" stroke="currentColor" strokeWidth="2" />
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

export function TodosView({
  client,
  projectId,
  active,
  pendingDeleteIds,
  tag,
  onOpenTask,
  onAddTask,
  onToggleDone,
  onReorderTask,
  onMoveTask,
  onDeleteTask,
}: {
  client: HitchClient;
  projectId: string;
  // The tag data layer (useTagMutations) — ONE instance in the shell, shared
  // with the dialog's tag lane so both surfaces write through one code path.
  tag: TagActions;
  // Whether this surface is live for keyboard nav — false while the task
  // dialog is up, so ↑↓/↵/Backspace don't fire underneath it (V1's `active`).
  active: boolean;
  // Tasks mid-delete-window (useTaskMutations) — hidden from every group.
  pendingDeleteIds: ReadonlySet<string>;
  /** Open a task in the dialog. */
  onOpenTask: (taskId: string) => void;
  /**
   * Open the capture card, filed into `sectionId` (null = loose). Every
   * container has its own add-row, so the destination is chosen by WHICH row
   * you clicked rather than by anything the capture card asks you.
   */
  onAddTask: (sectionId: string | null) => void;
  onToggleDone: (task: TaskItem, done: boolean) => void;
  onReorderTask: (taskId: string, sortOrder: string) => void;
  /**
   * File a task into a section (null = loose). The menu omits `sortOrder` and
   * gets a prepend; a drag passes the key it computed from where the row
   * actually landed.
   */
  onMoveTask: (
    task: TaskItem,
    sectionId: string | null,
    sortOrder?: string,
  ) => void;
  onDeleteTask: (task: TaskItem) => void;
}) {
  const [showAllDone, setShowAllDone] = useState(false);

  // The key is ["tasks", …] so the coarse per-table WS invalidation
  // (realtime.ts) hits it by prefix (["tags"] lives in useTagMutations).
  const tasks = useQuery({
    queryKey: ["tasks", { projectId }],
    queryFn: () => fetchTasks(client, projectId),
  });

  // The project's sections — the list's user-created structure. A project with
  // none renders exactly as it did before sections existed: one uninterrupted
  // list. Nothing to migrate, no empty state to design.
  const sections = useSections(client, projectId);
  // SORTED here, not taken as given. Two reasons the raw array can be out of
  // order: an optimistic reorder rewrites a row's sortOrder in place without
  // moving it, and the server's ORDER BY runs on a `text` column whose
  // collation is the database's, not ours (base62 keys mix case, where a
  // locale collation and byte order disagree). The rendered order already goes
  // through the fold's own comparator; the reorder maths reads THIS, so both
  // agree — otherwise "move down" twice silently no-ops the second time and
  // "move up" greys out on a section that plainly can move up.
  const sectionRows = useMemo(
    () => sortSections(sections.data ?? []),
    [sections.data],
  );
  const sectionMutations = useSectionMutations(client, projectId);
  const sectionIndexById = useMemo(
    () => new Map(sectionRows.map((section, i) => [section.id, i] as const)),
    [sectionRows],
  );

  // The row currently under the cursor, if a drag is in flight — the only
  // state the drag keeps. (The list itself is never forked: dnd-kit previews
  // the move by transforming the rows it already has.)
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Collapse is per machine, not per project row (sectionCollapse.ts). Reload
  // on project change so switching restores that project's own state rather
  // than leaking the previous one — same shape as the tag filter below.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() =>
    loadCollapsedSections(projectId),
  );
  useEffect(() => {
    setCollapsedIds(loadCollapsedSections(projectId));
    // Any in-flight drag belongs to the project we just left; its id means
    // nothing here.
    setDraggingId(null);
  }, [projectId]);
  // The write lives here, not in the setState updater (React may invoke an
  // updater twice, and a state updater has no business touching localStorage)
  // and not in an effect keyed on [projectId, collapsedIds] — that ordering
  // fires once with the OUTGOING project's set and the INCOMING project's id,
  // saving one project's collapse state under another's key.
  const toggleCollapsed = useCallback(
    (sectionId: string) => {
      const next = new Set(collapsedIds);
      if (!next.delete(sectionId)) next.add(sectionId);
      setCollapsedIds(next);
      saveCollapsedSections(projectId, next);
    },
    [collapsedIds, projectId],
  );

  // The attention join (M4 PR 6): every user assignment, keyed to match the
  // ["assignments"] WS invalidation so the chips advance live as the daemon
  // writes observed_state. Joined to tasks by task_id below.
  const assignments = useAllAssignments(client);
  const chats = useChats(client);
  // NOT cast down to AttentionAssignment: the chip needs the row's harness (to
  // pick a brand mark) and its chatId/machineId (to address the focus event),
  // and the join is generic precisely so callers keep their full row type.
  //
  // A task's chats, not its latest assignment: several agents can be live on one
  // task, and the row must speak for the most demanding of them (see rowState).
  const chatsByTask = useMemo(
    () => chatsByTaskId(assignments.data ?? []),
    [assignments.data],
  );
  // The chats themselves, for ONE fact the assignment can't carry: whether the
  // chat has a `handle`, i.e. whether clicking its chip can go anywhere. A
  // LINKED chat (adopted from the machine rather than spawned by Hitch) has
  // none, and without this the row offers "Open chat" on a chat it can't focus.
  // Same coarse ["chats"] key the dialog's band uses, so the two share one
  // cache entry rather than each paying for a fetch.
  const chatHandles = useMemo(
    () => new Map((chats.data ?? []).map((chat) => [chat.id, chat] as const)),
    [chats.data],
  );

  // Ack an attention item (done ∧ unreviewed): stamp reviewed_at so it drops
  // out of NEEDS YOU. The optimistic write lives in useAckAssignment, shared
  // with the cross-project "All tasks" list — same row, same context menu, so
  // the same one mutation rather than two that can roll back differently.
  const ackAssignment = useAckAssignment(client);

  // Rows in the delete window disappear NOW (the optimistic half of
  // delete-with-undo); an undo just stops hiding them.
  const visibleTasks = useMemo(
    () => (tasks.data ?? []).filter((task) => !pendingDeleteIds.has(task.id)),
    [tasks.data, pendingDeleteIds],
  );

  // View-local tag filter (AND semantics), persisted per project in
  // localStorage (V1's exact pattern). Reload it whenever the project changes
  // so switching projects restores that project's own filter rather than
  // leaking the previous one.
  const [filter, setFilter] = useState<TagFilter>(() => loadTagFilter(projectId));
  useEffect(() => {
    setFilter(loadTagFilter(projectId));
  }, [projectId]);
  const updateFilter = (next: TagFilter) => {
    setFilter(next);
    saveTagFilter(projectId, next);
  };
  // Selecting a tag clears Untagged and vice versa (untagged ∧ tag is empty).
  const toggleFilterTag = (name: string) => {
    const has = filter.tags.includes(name);
    updateFilter({
      untagged: false,
      tags: has ? filter.tags.filter((t) => t !== name) : [...filter.tags, name],
    });
  };
  const toggleFilterUntagged = () => {
    updateFilter({ tags: [], untagged: !filter.untagged });
  };
  const clearFilter = () => updateFilter(EMPTY_TAG_FILTER);
  const filterActive = isTagFilterActive(filter);

  // Derive once (unfiltered) for the facet counts + the truly-empty check,
  // then project through the active filter for what actually renders (V1's
  // exact split, now over placement instead of attention).
  const allGrouped = useMemo(
    () => deriveSectionedTasks(visibleTasks, sectionRows),
    [visibleTasks, sectionRows],
  );
  const grouped = useMemo(
    () => filterSectionedTasks(allGrouped, filter, tag.namesOf),
    [allGrouped, filter, tag.namesOf],
  );
  const facetCounts = useMemo(
    () => tagFacetCounts(visibleTasks.map(tag.namesOf), filter),
    [visibleTasks, filter, tag.namesOf],
  );
  const hasAnyTags = tag.options.length > 0;

  // A small activation distance keeps a plain click (open the task / toggle
  // the checkbox) from being read as a drag — matching V1's sortable lists.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Memoised because `navItems` depends on it: a fresh array each render would
  // rebuild the ↑↓ index (and the id→index map) on every keystroke.
  const doneVisible = useMemo(
    () => (showAllDone ? grouped.done : grouped.done.slice(0, DONE_PREVIEW)),
    [grouped.done, showAllDone],
  );

  // ─── The render plan ───────────────────────────────────────────────────────
  // ONE ordered list of containers that BOTH the markup and the keyboard-nav
  // index walk. The nav index is positional (data-idx over a flat list), so the
  // only safe way to keep ↑↓ agreeing with what's on screen is for the two to
  // read the same array — a second hand-maintained ordering is how this drifts.
  //
  // A collapsed section contributes a header and nothing else: its rows aren't
  // rendered, so they must not be navigable either.
  type Container = {
    /** null = the loose container (no header, always first). */
    section: SectionBucket<TaskItem>["section"] | null;
    tasks: TaskItem[];
    collapsed: boolean;
    /** Full open count, ignoring the filter — what the header displays. */
    total: number;
    /** Every open task filed here, ignoring the filter — for the chips a
     *  collapsed header surfaces. Filtering those would let a needs-you agent
     *  hide behind a collapsed section AND a tag filter at once. */
    allTasks: TaskItem[];
  };
  // Every task filed in a section, DONE included — what a delete actually
  // unfiles. The header's count is open-only (done tasks aren't structure), but
  // the delete confirm has to describe the real consequence.
  const filedCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of visibleTasks) {
      if (task.sectionId == null) continue;
      counts.set(task.sectionId, (counts.get(task.sectionId) ?? 0) + 1);
    }
    return counts;
  }, [visibleTasks]);

  const containers: Container[] = useMemo(() => {
    const unfilteredById = new Map(
      allGrouped.sections.map((b) => [b.section.id, b.tasks] as const),
    );
    return [
      {
        section: null,
        tasks: grouped.loose,
        collapsed: false,
        total: allGrouped.loose.length,
        allTasks: allGrouped.loose,
      },
      ...grouped.sections.map((bucket) => {
        const allTasks = unfilteredById.get(bucket.section.id) ?? bucket.tasks;
        return {
          section: bucket.section,
          tasks: bucket.tasks,
          collapsed: collapsedIds.has(bucket.section.id),
          total: allTasks.length,
          allTasks,
        };
      }),
    ];
  }, [grouped, allGrouped, collapsedIds]);

  const taskById = useMemo(
    () => new Map(visibleTasks.map((task) => [task.id, task])),
    [visibleTasks],
  );

  // Everything the row's chip slot needs, resolved from the task's chats. This
  // is the ONLY place a task's agent state reaches the list — there is no second
  // badge, no group membership, nothing else.
  //
  // The row gets the WHOLE chat list, not a lead chat: one chat draws V1's chip
  // exactly as before, several draw a stack (HarnessChip.tsx), and the row's
  // single reported state stays `rowState`'s reduce by demand — the ring can't
  // read calm while a second agent on the row is blocked on the user.
  const chipOf = (taskId: string): RowChips =>
    rowChips(chatsByTask.get(taskId), chatHandles);

  // The containers that are actually on screen. While filtering, a section with
  // no matches is noise — UNLESS it is collapsed and holding a live agent,
  // which its header is the only remaining place to show (V2's sidebar has no
  // attention count).
  //
  // This is computed ONCE and then used three times: the render walks it, the
  // ↑↓ index walks it, and the drag's item list is built from it. A second
  // hand-maintained ordering is how those drift apart.
  const displayed: Container[] = useMemo(
    () =>
      containers.filter(
        (container) =>
          !(
            filterActive &&
            container.section &&
            container.tasks.length === 0 &&
            !(container.collapsed && hasLiveAgent(container.allTasks, chipOf))
          ),
      ),
    // `chipOf` is a fresh closure each render but reads only `chatsByTask`,
    // which is the real dependency here.
    [containers, filterActive, chatsByTask],
  );

  // The drag's item list: every row and every section header, in render order,
  // as one array. See flatList.ts — this is the whole placement model.
  const slots = useMemo(
    () =>
      buildSlots(
        displayed.map((container) => ({
          sectionId: container.section?.id ?? null,
          taskIds: container.tasks.map((task) => task.id),
          collapsed: container.collapsed,
          // Matches the render: no add-row while filtering, so no slot for one.
          anchorId: filterActive ? null : addSlotId(container.section?.id ?? null),
        })),
      ),
    [displayed, filterActive],
  );
  const slotIds = useMemo(() => slots.map((slot) => slot.id), [slots]);

  // What the DragOverlay renders. dnd-kit's docs recommend an overlay for any
  // list that scrolls, and it is also what keeps the resting row still: with
  // one, `useSortable` stops transforming the drag source, so the row can no
  // longer appear to snap home whenever the pointer crosses a seam between
  // drop targets.
  const draggingTask = draggingId ? taskById.get(draggingId) : undefined;

  // The entire drop handler. One path, no branches per drop kind: ask the flat
  // list where the row ended up, then mint a key at that index.
  //
  // What makes this safe is that `placementAfterMove` runs the same `arrayMove`
  // the sorting strategy just animated, over the same array. The gap the user
  // watched open and the position written here are one computation, so they
  // cannot disagree — which every previous version of this code could, silently
  // and without an undo.
  function onDragEnd(event: DragEndEvent) {
    setDraggingId(null);
    const { active, over } = event;
    // No `over` means the release landed on nothing droppable — the gesture for
    // calling off a drag. Nothing moves.
    if (!over) return;

    const activeId = String(active.id);
    const task = taskById.get(activeId);
    if (!task) return;
    const placement = placementAfterMove(slots, activeId, String(over.id));
    if (!placement) return;

    const destination = displayed.find(
      (container) => (container.section?.id ?? null) === placement.sectionId,
    );
    if (!destination) return;

    // A move that changes nothing writes nothing — it would still be correct,
    // but it costs a PATCH and a re-render for a drag that went nowhere.
    const home = task.sectionId ?? null;
    const wasAt = destination.tasks.findIndex((t) => t.id === activeId);
    if (home === placement.sectionId && wasAt === placement.index) return;

    // `placement.index` counts the rows on SCREEN, and `destination.tasks` is
    // exactly those rows — except for a collapsed section, which shows none, so
    // the index is 0 and the drop prepends into it. Both are what you'd want.
    const siblings = destination.tasks.filter((t) => t.id !== activeId);
    // Which way to escape a run of EQUAL sortOrder keys, which are ordinary
    // data here (see listMutations). Only a move DOWN inside one list needs to
    // land below the run; everything else — a move up, an arrival from another
    // section — means above it.
    const bias = wasAt >= 0 && placement.index > wasAt ? "after" : "before";
    const sortOrder = sortOrderAtIndex(siblings, placement.index, bias);

    if (placement.sectionId === home) onReorderTask(activeId, sortOrder);
    else onMoveTask(task, placement.sectionId, sortOrder);
  }

  // ─── Keyboard nav (V1's, ported onto server rows) ──────────────────────────
  // The flat ↑↓ order = every VISIBLE row, top-to-bottom, matching render
  // order. Each container's add affordance is a real navigable item; section
  // headers are NOT (they're structure, and ↑↓ through a list of todos should
  // walk todos). Collapsed DONE overflow stays out because it isn't shown.
  const navItems = useMemo(
    () =>
      [
        ...displayed.flatMap((container) =>
          container.collapsed
            ? []
            : [
                // The capture affordance is hidden while a filter is active
                // (V1), so it drops out of the ↑↓ order too.
                ...(filterActive
                  ? []
                  : [
                      {
                        kind: "add" as const,
                        sectionId: container.section?.id ?? null,
                      },
                    ]),
                ...container.tasks.map((task) => ({ kind: "task" as const, task })),
              ],
        ),
        ...doneVisible.map((task) => ({ kind: "task" as const, task })),
      ],
    [displayed, doneVisible, filterActive],
  );
  const navIndexById = useMemo(
    () =>
      new Map(
        navItems.flatMap((item, i) =>
          item.kind === "task" ? ([[item.task.id, i]] as const) : [],
        ),
      ),
    [navItems],
  );
  // Keyboard actions on the highlighted row, V1's exact set. Bare keys only —
  // a modifier chord is someone else's shortcut — and the add-row is inert
  // for everything but ↵ (it's not a task).
  //   • ↑/↓ move the highlight by carrying DOM focus with it — focus IS the
  //     keyboard's highlight, painted with the same background hover uses.
  //   • ←/→ traverse the highlighted row's own controls (row body → checkbox).
  //   • Backspace/Delete removes the row — the keyboard twin of the
  //     right-click Delete, same handler + undo toast; no confirmation, undo
  //     is the safety net, and repeated presses bulk-delete serially since the
  //     highlight inherits the next row.
  //   • `e` toggles done, routing through the SAME onToggleDone as the
  //     checkbox so the undo toast comes along for free.
  const { selected, itemProps } = useListKeyboardNav({
    count: navItems.length,
    active,
    containerRef: scrollRef,
    onActivate: (i) => {
      const item = navItems[i];
      if (!item) return;
      if (item.kind === "add") onAddTask(item.sectionId);
      else onOpenTask(item.task.id);
    },
    onKeyDown: (e, ctx) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;

      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        if (ctx.selected < 0) return false;
        const row = scrollRef.current?.querySelector<HTMLElement>(
          `[data-idx="${ctx.selected}"]`,
        );
        if (!row) return false;
        // The row body itself (cell 0) plus its focusable controls in DOM
        // order: the checkbox, then the harness chip. DISABLED ones are left
        // out — .focus() on them is a no-op, so including one makes → look
        // like it stopped working (the chip is disabled until its chat starts).
        const cells = [
          row,
          ...[
            ...row.querySelectorAll<HTMLElement>(
              'button, [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((el) => !(el as HTMLButtonElement).disabled),
        ];
        const at = cells.indexOf(document.activeElement as HTMLElement);
        e.preventDefault(); // claim it so focus can never escape the row sideways
        (at < 0
          ? cells[0]
          : cells[at + (e.key === "ArrowRight" ? 1 : -1)]
        )?.focus();
        return true;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = navItems.length;
        if (!n) return true;
        const down = e.key === "ArrowDown";
        const next =
          ctx.selected < 0
            ? down
              ? 0
              : n - 1
            : Math.max(0, Math.min(n - 1, ctx.selected + (down ? 1 : -1)));
        ctx.setSelected(next);
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-idx="${next}"]`)
          ?.focus();
        return true;
      }

      const item = ctx.selected >= 0 ? navItems[ctx.selected] : undefined;
      if (!item || item.kind !== "task") return false;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        onDeleteTask(item.task);
        return true;
      }
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        onToggleDone(item.task, item.task.status !== "done");
        return true;
      }
      return false;
    },
  });
  // Swap the shared hook's `aria-selected` (invalid on role="button") for
  // `aria-current`, keeping data-idx intact. This is now the row's ONLY tie to
  // the keyboard cursor — the highlight itself is CSS (ROW_CHROME).
  const toRowItemProps = (i: number): RowNav["itemProps"] => {
    const { "aria-selected": _drop, ...rest } = itemProps(i);
    return { ...rest, "aria-current": i === selected };
  };
  const rowNav = (taskId: string): RowNav | undefined => {
    const i = navIndexById.get(taskId);
    if (i === undefined) return undefined;
    return { itemProps: toRowItemProps(i) };
  };
  // Each container has its OWN add-row, so the nav lookup is by container
  // rather than "the one add item".
  const addNav = (sectionId: string | null): RowNav | undefined => {
    const i = navItems.findIndex(
      (item) => item.kind === "add" && item.sectionId === sectionId,
    );
    if (i === -1) return undefined;
    return { itemProps: toRowItemProps(i) };
  };

  // Sections gate the render exactly as tasks do. They are two independent
  // queries, and letting tasks win the race renders the whole project as one
  // flat loose list for a frame — cosmetically a jump, but worse than that:
  // any capture, drag or uncheck in that window computes its key against the
  // wrong container, because the sections cache is empty too.
  if (tasks.isPending || sections.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading tasks…
      </div>
    );
  }
  // A failed sections fetch must NOT degrade to "this project has no sections":
  // that silently unfiles every task on screen and invites a duplicate section
  // to be created next to the ones it couldn't load.
  //
  // But only when there is nothing to show. React Query sets `status: "error"`
  // on a failed REFETCH too, with good data still cached — and every section
  // write plus every WS notify triggers a refetch, so keying on `isError`
  // alone would replace a perfectly renderable list with a red string on any
  // transient blip.
  const noTasks = tasks.data === undefined;
  const noSections = sections.data === undefined;
  if ((tasks.isError && noTasks) || (sections.isError && noSections)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-destructive">
        {String((noTasks ? tasks.error : sections.error) ?? "Failed to load")}
      </div>
    );
  }

  // A project with nothing in it at all — distinct from every state below,
  // including a project that only has empty sections.
  const isEmpty =
    allGrouped.loose.length +
      allGrouped.done.length +
      allGrouped.sections.reduce((n, b) => n + b.tasks.length, 0) ===
    0;
  // Filtered down to nothing (distinct from an empty project).
  // Count TASKS, not buckets. filterSectionedTasks used to drop emptied
  // sections, which made `sections.length` a proxy for "something matched";
  // it keeps them now (a collapsed one still has to show its agents), so a
  // project with any section would otherwise never report "no matches" — and
  // a filter that matches nothing would render a blank list with no
  // explanation at all.
  const noFilterMatches =
    filterActive &&
    grouped.loose.length +
      grouped.done.length +
      grouped.sections.reduce((n, b) => n + b.tasks.length, 0) ===
      0;
  const hiddenDone = grouped.done.length - doneVisible.length;

  const actions: RowActions = {
    onOpen: onOpenTask,
    onToggleDone,
    onDelete: onDeleteTask,
    onAck: ackAssignment,
    onMove: onMoveTask,
  };

  return (
    // group/nav + data-nav: which device owns the highlight (mouse vs keyboard,
    // whichever moved last). Every row reads it to decide whose highlight is
    // allowed to paint — see ROW_CHROME in TaskRow. Seeded here rather than in
    // the hook so the list is hoverable on its very first paint; from then on
    // useListKeyboardNav flips it imperatively, which React leaves alone
    // because the PROP never changes and React diffs props, not the DOM.
    <div
      ref={scrollRef}
      data-nav="mouse"
      className="group/nav flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="v2-todos"
    >
      {/* group/list: the "+ New section" affordance stays invisible until the
          pointer is somewhere in the list, so an untouched project shows no
          structural chrome at all. */}
      <div className="group/list mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 pt-7 pb-16">
        {(hasAnyTags || filterActive) && (
          <TagFilterBar
            options={tag.options}
            filter={filter}
            counts={facetCounts}
            colorOf={tag.colorOf}
            onToggleTag={toggleFilterTag}
            onToggleUntagged={toggleFilterUntagged}
            onClear={clearFilter}
          />
        )}

        {/* Loose tasks first (no header), then each section in order. Both
            this and the ↑↓ index walk `containers`, so they cannot drift.
            Drag-reorder and the capture add-row hide while a filter is active
            — the visible order is a projection then, not the real one (V1). */}
        {/* ONE DndContext and ONE SortableContext over the whole project. Not
            a context per section: a section here is a marker inside the list,
            not a container around part of it, which is what lets a row cross
            between sections without anything having to hand it over. */}
        <DndContext
          sensors={sensors}
          // `pointerWithin` and nothing else. It is a true hit test, so
          // releasing the row somewhere that isn't a drop target — the gutter
          // beside the column, the space under the list — reports no `over`,
          // and that is how a drag gets called off. Every more tolerant
          // algorithm (closestCenter, closestCorners) returns EVERY droppable
          // sorted by distance with no cutoff, so `over` would never be null
          // and a drag could never be abandoned; rectIntersection has a cutoff
          // but the dragged row is 672px wide, so it still overlaps the column
          // from halfway across the window.
          //
          // What makes one hit test sufficient is that the list has no holes
          // in it: header, add-row and rows are all slots, so there is no band
          // inside a section where the pointer finds nothing.
          collisionDetection={pointerWithin}
          onDragStart={(event) => setDraggingId(String(event.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDraggingId(null)}
        >
          <SortableContext items={slotIds} strategy={verticalListSortingStrategy}>
            {displayed.map((container) => {
              const sectionId = container.section?.id ?? null;
              return (
                <section
                  key={sectionId ?? "loose"}
                  className="flex flex-col pb-1.5"
                  data-testid={sectionId ? "v2-section" : "v2-loose"}
                  data-section-id={sectionId ?? undefined}
                >
                  {container.section && (
                    <DropSlot
                      id={headerSlotId(container.section.id)}
                      // Reach UP over the 22px of separation above this header
                      // (the previous section's pb-1.5 plus the column's
                      // gap-4) without moving it: -mt pulls the box up, pt
                      // pushes the content back down. That strip was the last
                      // place in the list where the pointer could find no drop
                      // target at all — a band you drag through on the way to
                      // every section boundary, where the preview gap closed
                      // and a release did nothing. It now behaves exactly as
                      // the header does, because it IS the header.
                      //
                      // It also fixes the gap the sorting strategy measures.
                      // `getItemGap` is per item, so the 22px landed on
                      // exactly one item per boundary — which then overshot
                      // its neighbours, and the header visibly overlapped its
                      // own add-row mid-drag. With the rects abutting, every
                      // item displaces by exactly the dragged row's height.
                      className="-mt-[22px] pt-[22px]"
                      // Filtering turns the order into a projection, so drag is
                      // off entirely and nothing in the list is a drop target.
                      disabled={filterActive}
                    >
                      <SectionHeader
                        name={container.section.name}
                        count={container.total}
                        matching={filterActive ? container.tasks.length : undefined}
                        collapsed={container.collapsed}
                        onToggle={() => toggleCollapsed(container.section!.id)}
                        onRename={(next) =>
                          sectionMutations.renameSection(container.section!.id, next)
                        }
                        menu={(startRename) => (
                          <SectionMenu
                            section={container.section!}
                            index={sectionIndexById.get(container.section!.id) ?? -1}
                            sections={sectionRows}
                            taskCount={filedCountById.get(container.section!.id) ?? 0}
                            mutations={sectionMutations}
                            onStartRename={startRename}
                          />
                        )}
                        hiddenChips={
                          <CollapsedSectionChips
                            tasks={container.allTasks}
                            chipOf={chipOf}
                          />
                        }
                      />
                    </DropSlot>
                  )}
                  {!container.collapsed && (
                    <>
                      {/* The add-row doubles as this container's "top" drop
                          target — see flatList.ts. Without it the strip between
                          a header and the first row is a hole, and a drop there
                          resolves to nothing. */}
                      {!filterActive && (
                        <DropSlot id={addSlotId(sectionId)} disabled={false}>
                          <AddTaskRow
                            onAdd={() => onAddTask(sectionId)}
                            nav={addNav(sectionId)}
                            hint={sectionId === null}
                          />
                        </DropSlot>
                      )}
                      {container.tasks.map((task) =>
                        filterActive ? (
                          <TaskRow
                            key={task.id}
                            task={task}
                            done={false}
                            tag={tag}
                            actions={actions}
                            chip={chipOf(task.id)}
                            sections={sectionRows}
                            nav={rowNav(task.id)}
                          />
                        ) : (
                          <SortableTaskRow
                            key={task.id}
                            task={task}
                            tag={tag}
                            actions={actions}
                            chip={chipOf(task.id)}
                            sections={sectionRows}
                            nav={rowNav(task.id)}
                          />
                        ),
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </SortableContext>
          {/* The row under the cursor. Deliberately a plain TaskRow and not a
              SortableTaskRow — rendering a component that calls useSortable
              inside the overlay is the pitfall dnd-kit's docs call out. */}
          <DragOverlay dropAnimation={null}>
            {draggingTask ? (
              <TaskRow
                task={draggingTask}
                done={false}
                tag={tag}
                actions={actions}
                chip={chipOf(draggingTask.id)}
                sections={sectionRows}
                drag={{ overlay: true }}
              />
            ) : null}
          </DragOverlay>
        </DndContext>

        {/* Hidden while filtering — the list is a projection then, and adding
            structure to a projection is how you file something somewhere you
            didn't mean. */}
        {!filterActive && <NewSectionRow onCreate={sectionMutations.createSection} />}

        {isEmpty && <EmptyHint />}

        {noFilterMatches && (
          <p className="px-2.5 py-8 text-center text-[13px] text-muted-foreground">
            No todos match this filter.
          </p>
        )}

        {/* DONE stays ONE list for the whole project, out of the sections and
            below them: a completed task is a receipt, not structure, and
            splitting the receipt per section fragments it for no gain. */}
        {grouped.done.length > 0 && (
          <section className="flex flex-col" data-testid="v2-done">
            <GroupHeader label="DONE" />
            {doneVisible.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                done
                tag={tag}
                actions={actions}
                chip={chipOf(task.id)}
                sections={sectionRows}
                nav={rowNav(task.id)}
              />
            ))}
            {(hiddenDone > 0 || showAllDone) && (
              <button
                type="button"
                onClick={() => setShowAllDone((v) => !v)}
                className="w-fit pl-[38px] pt-1.5 text-left text-[12px] leading-4 text-muted-foreground hover:text-foreground"
              >
                {showAllDone ? "Show less" : `Show ${hiddenDone} more completed`}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
