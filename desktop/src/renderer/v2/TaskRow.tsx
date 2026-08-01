import type { CSSProperties } from "react";
import {
  CheckIcon,
  CircleCheckIcon,
  CircleIcon,
  CopyIcon,
  FolderInputIcon,
  SquareArrowOutUpRightIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";

import { TagCombobox } from "@/components/tags/TagCombobox";
import { TagPillGroup } from "@/components/tags/TagPill";
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
import { cn } from "@/lib/utils";
import { copyTaskAgentPrompt } from "./agentPrompt";
import type { RowChips } from "./chipStack";
import { HarnessChipSlot } from "./HarnessChip";
// Type-only, so it is erased at build time — TodosView imports this module
// for its value (TaskRow), and this one takes nothing back but the type.
import type { TaskItem } from "./TodosView";
import type { TagActions } from "./useTagMutations";

// The list's row and the pieces that only it uses. Lifted out of TodosView
// so a second list — the cross-project "All tasks" view — renders the SAME row
// rather than a lookalike that drifts. The drag wrapper (SortableTaskRow)
// stays in TodosView: it is that view's placement machinery, not the row's.

// V1's TodoCheckbox, sibling'd: the one manual gesture, live on every row.
// stopPropagation on pointerdown keeps the tap from arming the row's drag
// sensor; on click, from opening the dialog.
export function TaskCheckbox({
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

// Keyboard-nav wiring, supplied only for rows that take part in ↑↓ navigation
// (the flat nav list). itemProps carries `aria-current` (valid on any role),
// NOT the shared hook's `aria-selected` — that attribute is only valid inside a
// composite widget, and these rows are role="button". The hook's aria-selected
// is stripped in `rowNav()`.
//
// Note what is NOT here: no `selected` flag and no mouse handler. The highlight
// is CSS on the row (`:hover` / `:focus-visible`, see ROW_CHROME), so React
// never renders the list to move it.
export type RowNav = {
  itemProps: {
    "data-idx": number;
    "aria-current": boolean;
  };
};

// The row's highlight, and the one place either list states it.
//
// A row is lit when it is the cursor. The mouse's cursor is `:hover`, the
// keyboard's is `:focus-visible`, and they paint the IDENTICAL background —
// so arrowing down the list slides the same block of colour the mouse leaves
// behind, instead of handing off to a focus ring. Whichever device moved last
// wins, via `data-nav` on the scroll container (useListKeyboardNav): the other
// device's variant is simply not generated, which is what stops a parked
// pointer from lighting a second row while you arrow past it.
//
// No `transition-colors`. The background is an answer to "where am I", and an
// answer that fades in over 150ms is late every single time.
export const ROW_CHROME =
  "group rounded-lg outline-none group-data-[nav=mouse]/nav:hover:bg-muted/60 group-data-[nav=kbd]/nav:focus-visible:bg-muted/60";

// The row's write actions, threaded from the shell's single useTaskMutations
// instance (one code path with the dialog ⋯ menu and the keyboard shortcuts).
export type RowActions = {
  onOpen: (taskId: string) => void;
  onToggleDone: (task: TaskItem, done: boolean) => void;
  onDelete: (task: TaskItem) => void;
  // Ack an attention item (done ∧ unreviewed): PATCH reviewed_at, which drops
  // the chip from amber back to idle. It lived on the row as a "Mark reviewed"
  // button until sections v1 consolidated every agent affordance into the chip;
  // the context menu keeps it one gesture away rather than deleting it.
  onAck: (assignmentId: string) => void;
  /** File the task into a section (null = loose), at the top of it. */
  onMove: (task: TaskItem, sectionId: string | null) => void;
};

// The row's right-click Tags ▸ submenu (V1's TagsSubmenu, sibling'd — it isn't
// exported and is welded to the frontmatter Todo): a searchable combobox that
// toggles the server's tags on/off for this task and creates+assigns a new
// one when the query matches nothing. TagCombobox and the submenu kit ARE the
// V1 modules, imported.
// The row's right-click "Move to ▸": file this task into a section, or back out
// to loose. Drag does the same thing with a mouse; this is the version that
// works from the keyboard, and the only one that reaches a collapsed section.
//
// The task lands at the TOP of its destination — the same prepend an uncheck
// and a capture use. A move is an act of attention, so the moved row should be
// where you'll see it, not buried at the bottom of wherever it went.
export function MoveToSubmenu({
  task,
  sections,
  onMove,
}: {
  task: TaskItem;
  sections: ReadonlyArray<{ id: string; name: string }>;
  onMove: (task: TaskItem, sectionId: string | null) => void;
}) {
  const current = task.sectionId ?? null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInputIcon />
        Move to
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem
          disabled={current === null}
          onClick={() => onMove(task, null)}
        >
          No section
        </ContextMenuItem>
        {sections.length > 0 && <ContextMenuSeparator />}
        {sections.map((section) => (
          <ContextMenuItem
            key={section.id}
            disabled={current === section.id}
            onClick={() => onMove(task, section.id)}
          >
            {section.name}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

export function TagsSubmenu({ task, tag }: { task: TaskItem; tag: TagActions }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <TagIcon />
        Tags
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="p-0">
        <TagCombobox
          mode="assign"
          options={tag.options}
          selected={new Set(tag.namesOf(task))}
          onToggle={(name) => tag.toggleTag(task, name)}
          onCreate={(name) => tag.createTag(task, name)}
          placeholder="Search or create tag…"
        />
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

export function TaskRow({
  task,
  done,
  tag,
  actions,
  chip,
  sections,
  drag,
  nav,
  projectName,
  onOpenProject,
}: {
  task: TaskItem;
  done: boolean;
  // Tag pills + the right-click Tags ▸ submenu, threaded from the shell's
  // single useTagMutations instance (same handlers as the dialog's tag lane).
  tag: TagActions;
  actions: RowActions;
  // The row's agent instrument. Always present (an empty slot when there's no
  // agent) so chips and tag pills form a column down the list.
  chip: RowChips;
  /** The project's sections, for the Move to ▸ submenu. Empty hides it. */
  sections: ReadonlyArray<{ id: string; name: string }>;
  // Present only for BACKLOG rows, which are drag-reorderable — dnd-kit's
  // sortable node/transform on the whole row (V1's whole-row drag). The
  // checkbox stops pointerdown so a drag can't start from it, and
  // PointerSensor's activation distance lets a plain click through to open.
  drag?: {
    setNodeRef?: (node: HTMLElement | null) => void;
    style?: CSSProperties;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown> | undefined;
    /** This is the row's resting node and the row is currently in flight. */
    dragging?: boolean;
    /** This is the DragOverlay copy — the thing actually under the cursor. */
    overlay?: boolean;
  };
  // Highlight + data-idx/aria-current/hover wiring when the row is navigable.
  nav?: RowNav;
  // Which project this task came from. Absent inside a project's own list —
  // the answer is the screen you're on — and present in the cross-project
  // "All tasks" view, where it is the one fact a row can't be read without.
  projectName?: string;
  /** Jump to that project. Only meaningful alongside `projectName`. */
  onOpenProject?: () => void;
}) {
  // Rendered on its own when there is no project to name, and inside the title
  // lane when there is — so a project list's row keeps EXACTLY the markup it
  // had before the label existed.
  const title = (
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
  );
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
            "flex h-[42px] cursor-pointer items-center gap-3 px-2.5",
            ROW_CHROME,
            // While the row is in flight it is the DragOverlay under the
            // cursor, not this node — this one stays put as a quiet gap showing
            // where it came from. (Without an overlay the row itself was
            // translated, which is why it used to snap home whenever the
            // pointer left every drop target.)
            drag?.dragging && "opacity-35",
            // The overlay copy: opaque over its neighbours, a hair of shadow —
            // no new chrome, no handle. Quiet. (V1)
            drag?.overlay &&
              "relative z-10 cursor-grabbing bg-background shadow-sm ring-1 ring-border/70",
          )}
        >
          <TaskCheckbox
            checked={done}
            onToggle={() => actions.onToggleDone(task, !done)}
          />
          {projectName ? (
            // The title lane: title and project share the row's flexible
            // middle. The project is `shrink-0` and the TITLE truncates first —
            // deliberate, because in a cross-project list "which project" is the
            // one thing you can't reconstruct from context. No separator
            // punctuation: the 7px gap does that work.
            <div className="flex min-w-0 flex-1 items-baseline gap-[7px]">
              {title}
              <button
                type="button"
                aria-label={`Go to ${projectName}`}
                // Same guard the checkbox uses: never arm the drag sensor, never
                // open the task dialog behind the jump.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenProject?.();
                }}
                className={cn(
                  "shrink-0 text-[12px] leading-[18px] text-muted-foreground underline-offset-[3px] decoration-border group-hover:underline",
                  // Dims with the tag pills, so a done row reads as one faded
                  // block rather than a faded row with a bright label on it.
                  done && "opacity-55",
                )}
              >
                {projectName}
              </button>
            </div>
          ) : (
            title
          )}
          <TagPillGroup tags={tag.namesOf(task)} colorOf={tag.colorOf} dimmed={done} />
          <HarnessChipSlot chats={chip.chats} state={chip.state} />
        </div>
      </ContextMenuTrigger>
      {/* Copy agent prompt is V2's server-native successor to Copy task path:
          it hands an existing chat the stable task id + exact CLI command. */}
      <ContextMenuContent>
        <ContextMenuItem onClick={() => actions.onOpen(task.id)}>
          <SquareArrowOutUpRightIcon />
          Open
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => void copyTaskAgentPrompt(task.id)}
        >
          <CopyIcon />
          Copy agent prompt
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.onToggleDone(task, !done)}>
          {done ? <CircleIcon /> : <CircleCheckIcon />}
          {done ? "Mark not done" : "Mark done"}
        </ContextMenuItem>
        {/* The agent finished and you haven't looked yet — the one attention
            case with something to DO besides opening the chat. It used to be a
            button on the row; the chip took the row's agent slot, so it lives
            here rather than disappearing. */}
        {chip.ackableId !== null && (
          <ContextMenuItem onClick={() => actions.onAck(chip.ackableId!)}>
            <CircleCheckIcon />
            Mark reviewed
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* Only where filing means something. With no sections the submenu's
            only entry is a permanently-disabled "No section" — a menu that can
            do nothing — and the cross-project "All tasks" list passes none on
            purpose: a section belongs to one project, so "move to ▸" has no
            answer there. */}
        {sections.length > 0 && (
          <MoveToSubmenu task={task} sections={sections} onMove={actions.onMove} />
        )}
        <TagsSubmenu task={task} tag={tag} />
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => actions.onDelete(task)}>
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
