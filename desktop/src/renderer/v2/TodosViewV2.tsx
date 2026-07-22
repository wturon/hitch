import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
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
  CheckIcon,
  CircleCheckIcon,
  CircleIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from "lucide-react";

import { TagPillGroup } from "@/components/tags/TagPill";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useListKeyboardNav } from "@/hooks/useListKeyboardNav";
import { toTagColor, type TagColorName } from "@/lib/tagColors";
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import { reorderSortOrder } from "./listMutations";
import { deriveTaskGroups } from "./todoGroups";

// The V2 Todos surface (M2 PR 2 read path + PR 4 list mutations): the selected
// project's tasks from the Hono server, grouped by attention exactly like V1's
// TodosView — BACKLOG in manual (sortOrder) order, DONE collapsed below — with
// V1's full row interaction set ported onto server rows:
//
//   • checkbox → check/uncheck (unchecking returns the row to the TOP of the
//     backlog), optimistic via the shell's useTaskMutations;
//   • whole-row drag reorder within BACKLOG (dnd-kit, single-row sortOrder
//     PATCH computed between the drop's neighbors);
//   • right-click context menu (V1's structure minus the V1-only entries —
//     tags land in PR 5; copy-path/detach/archive have no V2 counterpart);
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

// Exported so the shell's task-dialog query (AppV2) shares this EXACT queryFn
// under the same key — one cache entry, one live truth for both surfaces.
export async function fetchTasks(client: HitchClient, projectId: string) {
  const response = await client.tasks.$get({ query: { project_id: projectId } });
  if (!response.ok) throw new Error(`Failed to list tasks (${response.status})`);
  return await response.json();
}

async function fetchTags(client: HitchClient) {
  const response = await client.tags.$get();
  if (!response.ok) throw new Error(`Failed to list tags (${response.status})`);
  return await response.json();
}

export type TaskItem = Awaited<ReturnType<typeof fetchTasks>>[number];

// How many completed tasks the collapsed DONE group previews before the
// "Show N more completed" toggle — same cadence as V1 (DONE stays tucked away).
const DONE_PREVIEW = 3;

// V1's group header, verbatim: 11px small-caps label + trailing hairline. The
// amber NEEDS YOU treatment comes along for free for M4.
function GroupHeader({ label, amber }: { label: string; amber?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5">
      <span
        className={cn(
          "text-[11px] font-medium uppercase leading-[14px] tracking-[0.05em]",
          amber ? "text-amber-700 dark:text-amber-500/90" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className={cn("h-px flex-1", amber ? "bg-amber-500/35" : "bg-border")} aria-hidden />
    </div>
  );
}

// V1's TodoCheckbox, sibling'd: the one manual gesture, live on every row.
// stopPropagation on pointerdown keeps the tap from arming the row's drag
// sensor; on click, from opening the dialog.
function TaskCheckbox({
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

// Keyboard-nav highlight wiring, supplied only for rows that take part in ↑↓
// navigation (the flat nav list). Same shape as V1's RowNav: itemProps carries
// `aria-current` (valid on any role), NOT the shared hook's `aria-selected` —
// that attribute is only valid inside a composite widget, and these rows are
// role="button". The hook's aria-selected is stripped in `rowNav()` below.
type RowNav = {
  selected: boolean;
  itemProps: {
    "data-idx": number;
    "aria-current": boolean;
    onMouseMove: () => void;
  };
};

// The row's write actions, threaded from the shell's single useTaskMutations
// instance (one code path with the dialog ⋯ menu and the keyboard shortcuts).
type RowActions = {
  onOpen: (taskId: string) => void;
  onToggleDone: (task: TaskItem, done: boolean) => void;
  onDelete: (task: TaskItem) => void;
};

function TaskRow({
  task,
  done,
  tagNames,
  colorOf,
  actions,
  drag,
  nav,
}: {
  task: TaskItem;
  done: boolean;
  /** Resolved tag labels for the pill lane (tagIds → names, unknown ids dropped). */
  tagNames: string[];
  colorOf: (name: string) => TagColorName;
  actions: RowActions;
  // Present only for BACKLOG rows, which are drag-reorderable — dnd-kit's
  // sortable node/transform on the whole row (V1's whole-row drag). The
  // checkbox stops pointerdown so a drag can't start from it, and
  // PointerSensor's activation distance lets a plain click through to open.
  drag?: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: CSSProperties;
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown> | undefined;
    dragging: boolean;
  };
  // Highlight + data-idx/aria-current/hover wiring when the row is navigable.
  nav?: RowNav;
}) {
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
          data-testid="v2-task-row"
          aria-label={task.title}
          onClick={() => actions.onOpen(task.id)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('[role="checkbox"],button')) return;
            e.preventDefault();
            actions.onOpen(task.id);
          }}
          className={cn(
            "group flex h-[42px] cursor-pointer items-center gap-3 rounded-lg px-2.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            // Keyboard highlight. Hover sets the same selection (onMouseMove),
            // so mouse and keyboard converge on one highlighted row.
            nav?.selected && "bg-muted",
            // A dragged backlog row lifts subtly — opaque over its neighbours,
            // a hair of shadow — no new chrome, no handle. Quiet. (V1)
            drag?.dragging &&
              "relative z-10 bg-background shadow-sm ring-1 ring-border/70",
          )}
        >
          <TaskCheckbox
            checked={done}
            onToggle={() => actions.onToggleDone(task, !done)}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13.5px] leading-[18px]",
              done
                ? "text-neutral-400 line-through decoration-1 dark:text-neutral-500"
                : "text-foreground",
            )}
          >
            {task.title}
          </span>
          <TagPillGroup tags={tagNames} colorOf={colorOf} dimmed={done} />
        </div>
      </ContextMenuTrigger>
      {/* V1's row menu minus its V1-only entries: Tags ▸ lands in PR 5;
          Copy task path / Detach chat / Archive have no V2 counterpart
          (tasks aren't files; chats are M4; V2 has no archived state). */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => actions.onOpen(task.id)}>
          <SquareArrowOutUpRightIcon />
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.onToggleDone(task, !done)}>
          {done ? <CircleIcon /> : <CircleCheckIcon />}
          {done ? "Mark not done" : "Mark done"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => actions.onDelete(task)}>
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A BACKLOG row wrapped in dnd-kit sortable wiring (V1's SortableTodoRow):
// whole-row drag, transform/transition handed to TaskRow's root. Keyed by the
// task id (its sortable id).
function SortableTaskRow({
  task,
  tagNames,
  colorOf,
  actions,
  nav,
}: {
  task: TaskItem;
  tagNames: string[];
  colorOf: (name: string) => TagColorName;
  actions: RowActions;
  nav?: RowNav;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } =
    useSortable({ id: task.id });
  return (
    <TaskRow
      task={task}
      done={false}
      tagNames={tagNames}
      colorOf={colorOf}
      actions={actions}
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
// capture shortcut wired in AppV2.
function AddTaskRow({ onAdd, nav }: { onAdd: () => void; nav?: RowNav }) {
  return (
    <button
      type="button"
      data-testid="v2-add-task"
      {...nav?.itemProps}
      onClick={onAdd}
      className={cn(
        "group flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
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

export function TodosViewV2({
  client,
  projectId,
  active,
  pendingDeleteIds,
  onOpenTask,
  onAddTask,
  onToggleDone,
  onReorderTask,
  onDeleteTask,
}: {
  client: HitchClient;
  projectId: string;
  // Whether this surface is live for keyboard nav — false while the task
  // dialog is up, so ↑↓/↵/Backspace don't fire underneath it (V1's `active`).
  active: boolean;
  // Tasks mid-delete-window (useTaskMutations) — hidden from every group.
  pendingDeleteIds: ReadonlySet<string>;
  /** Open a task in the dialog. */
  onOpenTask: (taskId: string) => void;
  /** Open the capture card (the add-row affordance; `C` lives in AppV2). */
  onAddTask: () => void;
  onToggleDone: (task: TaskItem, done: boolean) => void;
  onReorderTask: (taskId: string, sortOrder: string) => void;
  onDeleteTask: (task: TaskItem) => void;
}) {
  const [showAllDone, setShowAllDone] = useState(false);

  // Keys are ["tasks", …] / ["tags"] so the coarse per-table WS invalidation
  // (realtime.ts) hits them by prefix.
  const tasks = useQuery({
    queryKey: ["tasks", { projectId }],
    queryFn: () => fetchTasks(client, projectId),
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags(client) });

  // Rows in the delete window disappear NOW (the optimistic half of
  // delete-with-undo); an undo just stops hiding them.
  const visibleTasks = useMemo(
    () => (tasks.data ?? []).filter((task) => !pendingDeleteIds.has(task.id)),
    [tasks.data, pendingDeleteIds],
  );
  const groups = useMemo(() => deriveTaskGroups(visibleTasks), [visibleTasks]);

  // tagIds → pill labels + colors. The registry of record is GET /tags; a task
  // link whose tag row hasn't loaded (or was deleted) renders no pill — never a
  // raw uuid. Colors resolve through V1's named palette (unknown names → gray).
  const tagById = useMemo(
    () => new Map((tags.data ?? []).map((tag) => [tag.id, tag])),
    [tags.data],
  );
  const colorByName = useMemo(
    () => new Map((tags.data ?? []).map((tag) => [tag.name, toTagColor(tag.color)])),
    [tags.data],
  );
  const tagNamesOf = (task: TaskItem) =>
    task.tagIds.flatMap((id) => {
      const tag = tagById.get(id);
      return tag ? [tag.name] : [];
    });
  const colorOf = (name: string) => colorByName.get(name) ?? toTagColor(undefined);

  // A small activation distance keeps a plain click (open the task / toggle
  // the checkbox) from being read as a drag — matching V1's sortable lists.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const backlogIds = groups.backlog.map((task) => task.id);
  function onBacklogDragEnd(event: DragEndEvent) {
    const { active: dragged, over } = event;
    if (!over || dragged.id === over.id) return;
    const from = backlogIds.indexOf(String(dragged.id));
    const to = backlogIds.indexOf(String(over.id));
    // One task's fractional index between the drop's neighbors — never a
    // whole-list rewrite (listMutations.ts).
    const sortOrder = reorderSortOrder(groups.backlog, from, to);
    if (sortOrder !== null) onReorderTask(String(dragged.id), sortOrder);
  }

  // ─── Keyboard nav (V1's, ported onto server rows) ──────────────────────────
  // The flat ↑↓ order = every VISIBLE row, top-to-bottom, matching render
  // order. The BACKLOG add affordance is a real navigable item; collapsed DONE
  // overflow is deliberately out because it is not shown. Ids are unique, so
  // an id→index map drives each row's highlight.
  const scrollRef = useRef<HTMLDivElement>(null);
  const doneVisible = showAllDone ? groups.done : groups.done.slice(0, DONE_PREVIEW);
  const navItems = useMemo(
    () =>
      [
        ...groups.needsYou.map((task) => ({ kind: "task" as const, task })),
        ...groups.working.map((task) => ({ kind: "task" as const, task })),
        { kind: "add" as const },
        ...groups.backlog.map((task) => ({ kind: "task" as const, task })),
        ...doneVisible.map((task) => ({ kind: "task" as const, task })),
      ],
    [groups.needsYou, groups.working, groups.backlog, doneVisible],
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
  //   • ↑/↓ move the highlight AND carry DOM focus with it, so the highlighted
  //     row (bg-muted) and the focus ring are always the same row.
  //   • ←/→ traverse the highlighted row's own controls (row body → checkbox).
  //   • Backspace/Delete removes the row — the keyboard twin of the
  //     right-click Delete, same handler + undo toast; no confirmation, undo
  //     is the safety net, and repeated presses bulk-delete serially since the
  //     highlight inherits the next row.
  //   • `e` toggles done, routing through the SAME onToggleDone as the
  //     checkbox so the undo toast comes along for free.
  const { selected, setSelected, itemProps } = useListKeyboardNav({
    count: navItems.length,
    active,
    containerRef: scrollRef,
    onActivate: (i) => {
      const item = navItems[i];
      if (!item) return;
      if (item.kind === "add") onAddTask();
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
        // The row body itself (cell 0) plus its focusable controls, in DOM
        // order (today just the checkbox; M4's chip will slot in for free).
        const cells = [
          row,
          ...row.querySelectorAll<HTMLElement>(
            'button, [tabindex]:not([tabindex="-1"])',
          ),
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
  // Keep the highlight locked to wherever DOM focus actually is (V1): Tab, a
  // click and the ↑↓ focus-move all land focus inside a row; this adopts that
  // row as the selection, so there's never a separate "focused" row and
  // "highlighted" row. Hover still highlights via itemProps.onMouseMove.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const onFocusIn = (e: FocusEvent) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-idx]",
      );
      if (!row) return;
      const i = Number(row.dataset.idx);
      if (Number.isInteger(i)) setSelected(i);
    };
    el.addEventListener("focusin", onFocusIn);
    return () => el.removeEventListener("focusin", onFocusIn);
  }, [active, setSelected]);

  // Swap the shared hook's `aria-selected` (invalid on role="button") for
  // `aria-current`, keeping data-idx + hover-to-highlight intact (V1).
  const toRowItemProps = (i: number): RowNav["itemProps"] => {
    const { "aria-selected": _drop, ...rest } = itemProps(i);
    return { ...rest, "aria-current": i === selected };
  };
  const rowNav = (taskId: string): RowNav | undefined => {
    const i = navIndexById.get(taskId);
    if (i === undefined) return undefined;
    return { selected: selected === i, itemProps: toRowItemProps(i) };
  };
  const addNavIndex = navItems.findIndex((item) => item.kind === "add");
  const addNav: RowNav | undefined =
    addNavIndex === -1
      ? undefined
      : {
          selected: selected === addNavIndex,
          itemProps: toRowItemProps(addNavIndex),
        };

  if (tasks.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading tasks…
      </div>
    );
  }
  if (tasks.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-destructive">
        {String(tasks.error)}
      </div>
    );
  }

  const isEmpty =
    groups.needsYou.length + groups.working.length + groups.backlog.length + groups.done.length ===
    0;
  const hiddenDone = groups.done.length - doneVisible.length;

  const actions: RowActions = {
    onOpen: onOpenTask,
    onToggleDone,
    onDelete: onDeleteTask,
  };

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="v2-todos"
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 pt-7 pb-16">
        {/* Scaffolding groups: always empty until M4, so these never render —
            kept so the M4 diff is "fill the arrays", not "rebuild the view". */}
        {groups.needsYou.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="NEEDS YOU" amber />
            {groups.needsYou.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                done={false}
                tagNames={tagNamesOf(task)}
                colorOf={colorOf}
                actions={actions}
                nav={rowNav(task.id)}
              />
            ))}
          </section>
        )}
        {groups.working.length > 0 && (
          <section className="flex flex-col">
            <GroupHeader label="WORKING" />
            {groups.working.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                done={false}
                tagNames={tagNamesOf(task)}
                colorOf={colorOf}
                actions={actions}
                nav={rowNav(task.id)}
              />
            ))}
          </section>
        )}

        {/* BACKLOG always shows its header + the capture add-row, mirroring
            V1 (the add-row renders in the empty state too). */}
        <section className="flex flex-col" data-testid="v2-backlog">
          <GroupHeader label="BACKLOG" />
          <AddTaskRow onAdd={onAddTask} nav={addNav} />
          <DndContext sensors={sensors} onDragEnd={onBacklogDragEnd}>
            <SortableContext items={backlogIds} strategy={verticalListSortingStrategy}>
              {groups.backlog.map((task) => (
                <SortableTaskRow
                  key={task.id}
                  task={task}
                  tagNames={tagNamesOf(task)}
                  colorOf={colorOf}
                  actions={actions}
                  nav={rowNav(task.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
          {isEmpty && <EmptyHint />}
        </section>

        {groups.done.length > 0 && (
          <section className="flex flex-col" data-testid="v2-done">
            <GroupHeader label="DONE" />
            {doneVisible.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                done
                tagNames={tagNamesOf(task)}
                colorOf={colorOf}
                actions={actions}
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
