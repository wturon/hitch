import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";

import { TagPillGroup } from "@/components/tags/TagPill";
import { toTagColor, type TagColorName } from "@/lib/tagColors";
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import { deriveTaskGroups } from "./todoGroups";

// The V2 Todos surface (M2 PR 2): the selected project's tasks from the Hono
// server, grouped by attention exactly like V1's TodosView — BACKLOG in manual
// (sortOrder) order, DONE collapsed below — with the same row chrome (checkbox,
// title, tag pills). READ-ONLY on purpose: capture is PR 3 and mutations are
// PR 4, so the checkbox is visual state, not a control, and a row click is a
// seam (onOpenTask) that the dialog will claim in PR 3.
//
// V1's TodoRow/GroupHeader aren't exported and are welded to the frontmatter
// Todo model (chat chips, context-menu writes), so the row chrome here is a
// slim sibling carrying the same classes; TagPillGroup IS the V1 component,
// imported — pills must render identically across the two shells.

async function fetchTasks(client: HitchClient, projectId: string) {
  const response = await client.tasks.$get({ query: { project_id: projectId } });
  if (!response.ok) throw new Error(`Failed to list tasks (${response.status})`);
  return await response.json();
}

async function fetchTags(client: HitchClient) {
  const response = await client.tags.$get();
  if (!response.ok) throw new Error(`Failed to list tags (${response.status})`);
  return await response.json();
}

type TaskItem = Awaited<ReturnType<typeof fetchTasks>>[number];

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

// The done checkbox, VISUAL ONLY until PR 4 wires check/uncheck: same paint as
// V1's TodoCheckbox but a span, not a button — nothing to click, no disabled
// styling to apologize for.
function TaskCheckboxVisual({ checked }: { checked: boolean }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-disabled="true"
      aria-label={checked ? "Done" : "Not done"}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-lg border-[1.5px]",
        checked
          ? "border-neutral-700 bg-neutral-700 text-white dark:border-neutral-300 dark:bg-neutral-300 dark:text-neutral-900"
          : "border-[#BEBEBE] dark:border-neutral-600",
      )}
    >
      {checked && <CheckIcon className="size-2.5" strokeWidth={4} />}
    </span>
  );
}

function TaskRow({
  task,
  done,
  tagNames,
  colorOf,
  onOpen,
}: {
  task: TaskItem;
  done: boolean;
  /** Resolved tag labels for the pill lane (tagIds → names, unknown ids dropped). */
  tagNames: string[];
  colorOf: (name: string) => TagColorName;
  onOpen: (taskId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="v2-task-row"
      aria-label={task.title}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen(task.id);
      }}
      className="group flex h-[42px] cursor-pointer items-center gap-3 rounded-lg px-2.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <TaskCheckboxVisual checked={done} />
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
  onOpenTask,
}: {
  client: HitchClient;
  projectId: string;
  /** PR 3 seam: the task dialog claims this. Until then the caller no-ops. */
  onOpenTask: (taskId: string) => void;
}) {
  const [showAllDone, setShowAllDone] = useState(false);

  // Keys are ["tasks", …] / ["tags"] so the coarse per-table WS invalidation
  // (realtime.ts) hits them by prefix.
  const tasks = useQuery({
    queryKey: ["tasks", { projectId }],
    queryFn: () => fetchTasks(client, projectId),
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => fetchTags(client) });

  const groups = useMemo(() => deriveTaskGroups(tasks.data ?? []), [tasks.data]);

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
  const doneVisible = showAllDone ? groups.done : groups.done.slice(0, DONE_PREVIEW);
  const hiddenDone = groups.done.length - doneVisible.length;

  const rowProps = { colorOf, onOpen: onOpenTask };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="v2-todos">
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
                {...rowProps}
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
                {...rowProps}
              />
            ))}
          </section>
        )}

        {/* BACKLOG always shows its header (it will host the capture affordance
            in PR 3), mirroring V1. */}
        <section className="flex flex-col" data-testid="v2-backlog">
          <GroupHeader label="BACKLOG" />
          {groups.backlog.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              done={false}
              tagNames={tagNamesOf(task)}
              {...rowProps}
            />
          ))}
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
                {...rowProps}
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
