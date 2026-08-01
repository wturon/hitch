import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { TagFilterBar } from "@/components/tags/TagFilterBar";
import { useListKeyboardNav } from "@/hooks/useListKeyboardNav";
import type { HitchClient } from "@/lib/server/client";
import { deriveAllTasks } from "./allTasksSort";
import { rowChips, type RowChips } from "./chipStack";
import { TaskRow, type RowActions, type RowNav } from "./TaskRow";
import {
  isTagFilterActive,
  loadTagFilter,
  saveTagFilter,
  taskMatchesTagFilter,
  tagFacetCounts,
  EMPTY_TAG_FILTER,
  type TagFilter,
} from "./tagFilter";
import { chatsByTaskId } from "./todoGroups";
// Type-only, so nothing here depends on the project view at build time — the
// two are siblings, not layers.
import type { TaskItem } from "./TodosView";
import { useAckAssignment } from "./useAckAssignment";
import { useAllAssignments } from "./useAssignments";
import type { TagActions } from "./useTagMutations";

// "All tasks": every task the user owns, across every project, as ONE flat
// list — a SIBLING of TodosView rather than a mode of it.
//
// The split is deliberate. Every system in the project view (drop slots, drag
// placement, section collapse, the positional nav index, the per-container
// add-row) is written against a single project, and a cross-project list has no
// answer for any of them: there is no shared manual order to drag inside, and a
// section belongs to exactly one project. Threading a `projectId | null` through
// all of that would leave one 1500-line component with two modes and a dozen
// places where "which one am I" has to be re-asked correctly.
//
// So this view is a PROJECTION. The visible order is `deriveAllTasks` — project
// name, then that project's own manual order (allTasksSort.ts, which is also
// what `hitch tasks list` prints) — and nobody can edit it here, because it
// isn't a real order anyone owns. Withheld on purpose, and NOT to be added:
// the add-row, drag reorder, sections and "+ New section".
//
// What IS live is everything that is a property of the TASK rather than of its
// position: check/uncheck, open, tag assign, delete, the agent chip, and the
// keyboard set (↑↓/↵, ←→ inside a row, Backspace/Delete). The row is literally
// TaskRow — the same component the project list renders — so the two surfaces
// cannot drift into lookalikes.
//
// The tag filter is the project view's, with its own persisted state (a filter
// is about what you're looking at, and "all tasks" is a different thing to be
// looking at than any one project).

// Exported so the shell can share this EXACT queryFn under the same key —
// one cache entry, one live truth, mirroring `fetchTasks` in TodosView.
export async function fetchAllTasks(client: HitchClient) {
  // No `project_id`: the server scopes GET /tasks by the owner join
  // (routes/tasks.ts), so an unfiltered list is exactly "every task I own".
  const response = await client.tasks.$get({ query: {} });
  if (!response.ok) throw new Error(`Failed to list tasks (${response.status})`);
  return await response.json();
}

// The projects list, for id → name. Same key App's own projects query uses,
// so the two share one cache entry and one WS invalidation; this view is
// mountable without the shell having fetched first.
export async function fetchAllTasksProjects(client: HitchClient) {
  const response = await client.projects.$get();
  if (!response.ok) throw new Error(`Failed to list projects (${response.status})`);
  return await response.json();
}

// The cache key for the cross-project list. It MUST be this shape: the coarse
// WS invalidation fires on the ["tasks"] prefix, and useTaskMutations /
// useTagMutations patch every ["tasks", …] entry optimistically — a key that
// doesn't sit under that prefix would show stale rows after every write.
// `{ projectId: undefined }` (not `{}`) matches what useTaskMutations builds
// from a null project scope; React Query's hash drops undefined values, so the
// two hash identically, and spelling it out keeps the agreement visible.
export const ALL_TASKS_QUERY_KEY = ["tasks", { projectId: undefined }] as const;

// The tag filter's persistence scope. tagFilter.ts keys storage by project id;
// this view is not a project, so it gets its own constant scope — the stored key
// is `hitch:v2:todo-tag-filter:all-tasks`. A project id is a uuid, so it can
// never collide, and a project's saved filter is never adopted here (nor this
// one there): the two are different questions about different lists.
export const ALL_TASKS_FILTER_SCOPE = "all-tasks";

// A task that knows its project — what this whole view is about, and what
// `deriveAllTasks` orders by.
//
// The narrowing is real, not cosmetic: `tasks.project_id` is nullable in the
// schema, so the generated row type says `string | null`. GET /tasks reaches
// every row through an inner join on `projects` (routes/tasks.ts), so nothing
// the server can return actually has a null — but the type can't know that, and
// a cast would be a claim rather than a check. `ownedTasks` below filters
// instead: the impossible row is simply not in the list, rather than crashing a
// lookup or rendering a row with no project label.
type OwnedTask = TaskItem & { projectId: string };

// How many completed tasks the collapsed DONE group previews before the
// "Show N more completed" toggle — the project view's cadence.
const DONE_PREVIEW = 3;

// The project view's group header (11px small-caps label + trailing hairline),
// copied rather than exported: DONE is the only caller on either surface, and
// the project view's copy is itself V1's, carried the same way.
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

/** `a`, `a and b`, `a, b and c` — an English list, no Oxford comma. */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What to say when the filter matches nothing.
 *
 * It NAMES the active tags instead of saying "no todos match this filter",
 * because the filter is ANDed and that is the single thing that trips people
 * up: two tags that each have plenty of tasks can intersect in zero, and a
 * generic sentence reads as "the list is broken" rather than "you asked for the
 * overlap". Saying "both" (2) and "all of" (3+) puts the conjunction in the
 * sentence, where it can be read.
 *
 * Untagged is exclusive of tag selections (tagFilter.ts), so it gets its own
 * sentence — and it says the useful inverse rather than restating the filter.
 *
 * Pure and exported for its unit test; the empty filter can't reach this (an
 * inactive filter hides nothing) but it degrades to a plain sentence anyway.
 */
export function noMatchesMessage(filter: TagFilter): string {
  if (filter.untagged) return "Everything here carries at least one tag.";
  const tags = filter.tags;
  if (tags.length === 0) return "Nothing here.";
  if (tags.length === 1) return `Nothing is tagged ${tags[0]}.`;
  if (tags.length === 2) return `Nothing is tagged both ${tags[0]} and ${tags[1]}.`;
  return `Nothing is tagged all of ${joinAnd(tags)}.`;
}

// CONTRACT — the fixed seam between the shell (App) and this view. Do not
// change the shape without changing both sides.
export interface AllTasksViewProps {
  client: HitchClient;
  /** Live for keyboard nav only while no dialog floats above the list. */
  active: boolean;
  /** Tasks mid-delete-window — hidden from the list. */
  pendingDeleteIds: ReadonlySet<string>;
  /** The shell's single useTagMutations instance. */
  tag: TagActions;
  onOpenTask: (taskId: string) => void;
  /** Jump the rail to a project (the row's project label). */
  onSelectProject: (projectId: string) => void;
  onToggleDone: (task: TaskItem, done: boolean) => void;
  onDeleteTask: (task: TaskItem) => void;
}

export function AllTasksView({
  client,
  active,
  pendingDeleteIds,
  tag,
  onOpenTask,
  onSelectProject,
  onToggleDone,
  onDeleteTask,
}: AllTasksViewProps) {
  const [showAllDone, setShowAllDone] = useState(false);

  const tasks = useQuery({
    queryKey: ALL_TASKS_QUERY_KEY,
    queryFn: () => fetchAllTasks(client),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchAllTasksProjects(client),
  });

  const projectNames = useMemo(
    () =>
      new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );

  // The attention join, exactly as the project list does it: one coarse
  // ["assignments"] query, keyed to match the WS invalidation, folded to a
  // task's chats so the chips advance live.
  const assignments = useAllAssignments(client);
  const chatsByTask = useMemo(
    () => chatsByTaskId(assignments.data ?? []),
    [assignments.data],
  );
  const ackAssignment = useAckAssignment(client);

  // Rows in the delete window disappear NOW (the optimistic half of
  // delete-with-undo); an undo just stops hiding them. Same pass narrows to
  // OwnedTask — see the type's note.
  const visibleTasks = useMemo(
    () =>
      (tasks.data ?? []).filter(
        (task): task is OwnedTask =>
          task.projectId !== null && !pendingDeleteIds.has(task.id),
      ),
    [tasks.data, pendingDeleteIds],
  );

  // The view's own tag filter, persisted under its own scope. The project view
  // reloads its filter whenever the project changes; this list has no such
  // input, so it loads once and is never reset out from under the user.
  const [filter, setFilter] = useState<TagFilter>(() =>
    loadTagFilter(ALL_TASKS_FILTER_SCOPE),
  );
  const updateFilter = (next: TagFilter) => {
    setFilter(next);
    saveTagFilter(ALL_TASKS_FILTER_SCOPE, next);
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

  // Fold once unfiltered — that is what the facet counts and the
  // truly-empty check are about — then project through the filter for what
  // actually renders (the project view's exact split).
  const allGrouped = useMemo(
    () => deriveAllTasks(visibleTasks, projectNames),
    [visibleTasks, projectNames],
  );
  // `keep` stays typed on OwnedTask, not TaskItem: widening here would hand the
  // rows back with `projectId: string | null` and the project label — the one
  // thing this view exists to show — would need a cast to render at all.
  const grouped = useMemo(() => {
    if (!filterActive) return allGrouped;
    const keep = (list: OwnedTask[]) =>
      list.filter((task) => taskMatchesTagFilter(tag.namesOf(task), filter));
    return { open: keep(allGrouped.open), done: keep(allGrouped.done) };
  }, [allGrouped, filterActive, filter, tag.namesOf]);
  const facetCounts = useMemo(
    () => tagFacetCounts(visibleTasks.map(tag.namesOf), filter),
    [visibleTasks, filter, tag.namesOf],
  );
  const hasAnyTags = tag.options.length > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Memoised because `navItems` depends on it: a fresh array each render would
  // rebuild the ↑↓ index on every keystroke.
  const doneVisible = useMemo(
    () => (showAllDone ? grouped.done : grouped.done.slice(0, DONE_PREVIEW)),
    [grouped.done, showAllDone],
  );

  // ─── Keyboard nav (the project view's, over a flatter list) ────────────────
  // The ↑↓ order IS the render order: every open row, then the DONE rows that
  // are actually on screen. No add-row and no section headers to skip, so the
  // index is just the two arrays end to end — but it is still built from the
  // same values the markup walks, so the two cannot drift.
  const navItems = useMemo(
    () => [...grouped.open, ...doneVisible],
    [grouped.open, doneVisible],
  );
  const navIndexById = useMemo(
    () => new Map(navItems.map((task, i) => [task.id, i] as const)),
    [navItems],
  );
  // Bare keys only — a modifier chord is someone else's shortcut.
  //   • ↑/↓ move the highlight by carrying DOM focus with it — focus IS the
  //     keyboard's highlight, painted with the same background hover uses.
  //   • ←/→ traverse the highlighted row's own controls (row body → checkbox →
  //     project label → chip).
  //   • Backspace/Delete removes the row (same handler + undo toast as the
  //     right-click Delete); `e` toggles done through the same onToggleDone as
  //     the checkbox, so the undo toast comes along for free.
  const { selected, itemProps } = useListKeyboardNav({
    count: navItems.length,
    active,
    containerRef: scrollRef,
    onActivate: (i) => {
      const task = navItems[i];
      if (task) onOpenTask(task.id);
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
        // order. DISABLED ones are left out — .focus() on them is a no-op, so
        // including one makes → look like it stopped working.
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

      const task = ctx.selected >= 0 ? navItems[ctx.selected] : undefined;
      if (!task) return false;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        onDeleteTask(task);
        return true;
      }
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        onToggleDone(task, task.status !== "done");
        return true;
      }
      return false;
    },
  });
  // Swap the shared hook's `aria-selected` (invalid on role="button") for
  // `aria-current`, keeping data-idx intact. This is now the row's ONLY tie to
  // the keyboard cursor — the highlight itself is CSS (ROW_CHROME in TaskRow).
  const rowNav = (taskId: string): RowNav | undefined => {
    const i = navIndexById.get(taskId);
    if (i === undefined) return undefined;
    const { "aria-selected": _drop, ...rest } = itemProps(i);
    return { itemProps: { ...rest, "aria-current": i === selected } };
  };

  // The row's chip slot, resolved from the task's chats — the ONLY place a
  // task's agent state reaches this list.
  const chipOf = (taskId: string): RowChips => rowChips(chatsByTask.get(taskId));

  // Projects gate the render exactly as tasks do. They are two independent
  // queries, and letting tasks win the race renders every row with no project
  // label and in the unresolved-id order — a list whose one irreplaceable fact
  // is missing, which then reshuffles under the cursor when the names land.
  if (tasks.isPending || projects.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading tasks…
      </div>
    );
  }
  // A failed projects fetch must NOT degrade to "these tasks have no project":
  // the label is the one fact a cross-project row can't be read without.
  //
  // But only when there is nothing to show. React Query sets `status: "error"`
  // on a failed REFETCH too, with good data still cached — and every write plus
  // every WS notify triggers a refetch, so keying on `isError` alone would
  // replace a perfectly renderable list with a red string on any transient blip.
  const noTasks = tasks.data === undefined;
  const noProjects = projects.data === undefined;
  if ((tasks.isError && noTasks) || (projects.isError && noProjects)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-destructive">
        {String((noTasks ? tasks.error : projects.error) ?? "Failed to load")}
      </div>
    );
  }

  // Nothing anywhere — distinct from a filter that matched nothing.
  const isEmpty = allGrouped.open.length + allGrouped.done.length === 0;
  const noFilterMatches =
    filterActive && grouped.open.length + grouped.done.length === 0;
  const hiddenDone = grouped.done.length - doneVisible.length;

  const actions: RowActions = {
    onOpen: onOpenTask,
    onToggleDone,
    onDelete: onDeleteTask,
    onAck: ackAssignment,
    // Unreachable: `sections` is empty on every row here, so the Move to ▸
    // submenu never renders (TaskRow.tsx). Filing is project-scoped and this
    // list spans projects — there is no destination to offer.
    onMove: () => {},
  };

  const row = (task: OwnedTask, done: boolean) => (
    <TaskRow
      key={task.id}
      task={task}
      done={done}
      tag={tag}
      actions={actions}
      chip={chipOf(task.id)}
      sections={[]}
      nav={rowNav(task.id)}
      projectName={projectNames.get(task.projectId)}
      onOpenProject={() => onSelectProject(task.projectId)}
    />
  );

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
      data-testid="v2-all-tasks"
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 pt-7 pb-16">
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

        {/* One flat list, no headers. The clustering comes from the ORDER —
            project name, then that project's own manual order — so same-project
            rows land adjacent without a rule drawn across the page
            (allTasksSort.ts). */}
        {grouped.open.length > 0 && (
          <section className="flex flex-col" data-testid="v2-all-open">
            {grouped.open.map((task) => row(task, false))}
          </section>
        )}

        {isEmpty && (
          <div className="mt-16 flex flex-col items-center gap-1.5 text-center">
            <span className="text-[13px] text-muted-foreground">No todos yet</span>
            <span className="text-[12px] text-neutral-400 dark:text-neutral-500">
              Everything you capture in a project shows up here.
            </span>
          </div>
        )}

        {noFilterMatches && (
          <p className="px-2.5 py-8 text-center text-[13px] text-muted-foreground">
            {noMatchesMessage(filter)}
          </p>
        )}

        {/* DONE is ONE list across every project, ordered by completion: a
            completed task is a receipt, and receipts read chronologically. */}
        {grouped.done.length > 0 && (
          <section className="flex flex-col" data-testid="v2-done">
            <GroupHeader label="DONE" />
            {doneVisible.map((task) => row(task, true))}
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
