"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  BookIcon,
  BotIcon,
  Columns2Icon,
  CornerDownLeftIcon,
  FileTextIcon,
  HashIcon,
  ListTodoIcon,
  MessageCircleIcon,
  PlusIcon,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandMeta,
} from "@/components/ui/command";

// The palette is active-project scoped: it searches the active project's tasks
// and notes and switches between projects. Cross-project search is out of scope.
export interface PaletteProject {
  id: Id<"projects">;
  name: string;
}
export interface PaletteTask {
  path: string; // tasks/<slug>/task.md — the board's selection key
  title: string;
  meta: string; // column/status name, shown as the mono tag
}
export interface PaletteNote {
  slug: string;
  title: string;
  meta: string; // freeform note type, shown as the mono tag
}
export interface PaletteAutomation {
  path: string;
  title: string;
  meta: string;
}
export interface PaletteAction {
  id: string;
  title: string;
  keywords: string[];
  meta?: string;
  disabled?: boolean;
  icon: ReactNode;
  onRun: () => void;
}

// "debug" and "editor-sandbox" are intentionally NOT in WORKSPACE_VIEWS below —
// they're internal surfaces (the account menu / a ⌘K action), not per-project
// tabs, so they stay out of the header pills, ⌘-number jumps, and Ctrl+Tab cycle.
export type WorkspaceView =
  | "todos"
  | "board"
  | "notes"
  | "chats"
  | "automations"
  | "debug"
  | "editor-sandbox";

// The per-project views, in tab order — the single source of truth shared by the
// header pills, the ⌘-number jump shortcuts, and the Ctrl+Tab cycle (all in
// App.tsx). Adding a view here lights it up everywhere. Title is what the palette
// query matches against ("tasks" / "notes" / "chats" / "automations").
// The first view keeps the internal `board` id but the product label is "Tasks".
export const WORKSPACE_VIEWS: {
  view: WorkspaceView;
  title: string;
  Icon: typeof BookIcon;
}[] = [
  { view: "todos", title: "Todos", Icon: ListTodoIcon },
  { view: "board", title: "Tasks", Icon: Columns2Icon },
  { view: "notes", title: "Notes", Icon: BookIcon },
  { view: "chats", title: "Chats", Icon: MessageCircleIcon },
  // Automations is hidden for the release — it stays a valid WorkspaceView (the
  // view, component, and App routing are intact) but is omitted here so it drops
  // out of the header pills, ⌘-number jumps, Ctrl+Tab cycle, and ⌘K palette.
  // Re-add this entry to bring the tab back.
  // { view: "automations", title: "Automations", Icon: BotIcon },
];

// Rank by searchable text: prefix > substring. Ties keep input order (already
// recency- or board-sorted upstream). An empty query returns the list unchanged.
function rankByText<T>(
  items: T[],
  query: string,
  searchableText: (item: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const title = searchableText(item).toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 2;
    else if (title.includes(q)) score = 1;
    if (score >= 0) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}

function rankByTitle<T extends { title: string }>(
  items: T[],
  query: string,
): T[] {
  return rankByText(items, query, (item) => item.title);
}

function actionSearchText(action: PaletteAction): string {
  return [action.title, action.meta, ...action.keywords]
    .filter(Boolean)
    .join(" ");
}

// A fixed-width (20px) leading icon slot so every row's text aligns regardless
// of which glyph it carries.
function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

// The dark rounded action square that fronts every create row.
function CreateIcon() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
      <PlusIcon className="size-3" />
    </span>
  );
}

// A create row whose label quotes the typed query ("New task **\"foo\"**"), or a
// plain label when the query is empty.
function CreateRow({
  value,
  label,
  query,
  onRun,
}: {
  value: string;
  label: string;
  query: string;
  onRun: () => void;
}) {
  return (
    <CommandItem value={value} onSelect={onRun}>
      <CreateIcon />
      {query ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-muted-foreground">{label}</span>
          <span className="truncate font-medium text-foreground">
            “{query}”
          </span>
        </span>
      ) : (
        <span className="text-foreground">{label}</span>
      )}
    </CommandItem>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  activeProjectId,
  activeProjectName,
  currentView,
  tasks,
  notes,
  automations,
  actions,
  onSelectProject,
  onSelectView,
  onOpenTask,
  onCreateTask,
  onOpenNote,
  onCreateNote,
  onOpenAutomation,
  onCreateAutomation,
  onCreateProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: PaletteProject[];
  activeProjectId: Id<"projects">;
  activeProjectName: string;
  currentView: WorkspaceView;
  tasks: PaletteTask[];
  notes: PaletteNote[];
  automations: PaletteAutomation[];
  actions: PaletteAction[];
  onSelectProject: (id: Id<"projects">) => void;
  onSelectView: (view: WorkspaceView) => void;
  onOpenTask: (path: string) => void;
  onCreateTask: (title: string) => void;
  onOpenNote: (slug: string) => void;
  onCreateNote: (title: string) => void;
  onOpenAutomation: (path: string) => void;
  onCreateAutomation: (title: string) => void;
  onCreateProject: (name: string) => void;
}) {
  const [query, setQuery] = useState("");

  // Fresh query on every open — the palette is a throwaway surface, not a
  // persistent filter.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const trimmed = query.trim();
  const rankedTasks = useMemo(() => rankByTitle(tasks, query), [tasks, query]);
  const rankedNotes = useMemo(() => rankByTitle(notes, query), [notes, query]);
  const rankedAutomations = useMemo(
    () => rankByTitle(automations, query),
    [automations, query],
  );
  const rankedViews = useMemo(
    () => rankByTitle(WORKSPACE_VIEWS, query),
    [query],
  );
  const rankedActions = useMemo(
    () => rankByText(actions, query, actionSearchText),
    [actions, query],
  );
  // rankByTitle keys off `title`; projects carry `name`, so alias it for ranking.
  const rankedProjects = useMemo(
    () =>
      rankByTitle(
        projects.map((p) => ({ ...p, title: p.name })),
        query,
      ),
    [projects, query],
  );
  const noMatches =
    trimmed !== "" &&
    rankedTasks.length === 0 &&
    rankedNotes.length === 0 &&
    rankedAutomations.length === 0 &&
    rankedViews.length === 0 &&
    rankedActions.length === 0 &&
    rankedProjects.length === 0;

  // Run an action and dismiss. Every row routes through here so the palette
  // always closes after acting.
  function run(action: () => void) {
    action();
    onOpenChange(false);
  }

  // The project rows — shared between the empty state and search results. The
  // active project is tagged `active`.
  const projectRows = (list: PaletteProject[]) =>
    list.map((p) => (
      <CommandItem
        key={p.id}
        value={`project:${p.id}`}
        onSelect={() => run(() => onSelectProject(p.id))}
      >
        <RowIcon>
          <HashIcon className="size-4" />
        </RowIcon>
        <span className="truncate">{p.name}</span>
        {p.id === activeProjectId && <CommandMeta>active</CommandMeta>}
      </CommandItem>
    ));

  // The Board / Notes rows — shared between the empty state and search results.
  // The current view is tagged `active`, mirroring the project switcher.
  const viewRows = (views: typeof WORKSPACE_VIEWS) =>
    views.map(({ view, title, Icon }) => (
      <CommandItem
        key={view}
        value={`view:${view}`}
        onSelect={() => run(() => onSelectView(view))}
      >
        <RowIcon>
          <Icon className="size-4" />
        </RowIcon>
        <span className="truncate">{title}</span>
        {view === currentView && <CommandMeta>active</CommandMeta>}
      </CommandItem>
    ));

  const actionRows = (list: PaletteAction[]) =>
    list.map((action) => (
      <CommandItem
        key={action.id}
        value={`action:${action.id}`}
        disabled={action.disabled}
        onSelect={() => run(action.onRun)}
      >
        <RowIcon>{action.icon}</RowIcon>
        <span className="truncate">{action.title}</span>
        {action.meta && <CommandMeta>{action.meta}</CommandMeta>}
      </CommandItem>
    ));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-[#141418]/30 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          // Upper third, fixed 640px, soft shadow + hairline border — overlays
          // any view (distinct from the full-pane Notes search).
          className="fixed top-[14vh] left-1/2 z-50 w-[640px] max-w-[calc(100%-2rem)] -translate-x-1/2 overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl ring-1 ring-border outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          {/* shouldFilter=false: we feed cmdk our own ranked, grouped lists; it
              still owns keyboard nav, selection, and a11y across what we render. */}
          <Command shouldFilter={false} loop>
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search tasks, notes, projects, settings, or actions…"
            />
            <CommandList>
              {trimmed === "" ? (
                <>
                  <CommandGroup heading="Jump to">
                    {projectRows(projects)}
                  </CommandGroup>
                  <CommandGroup heading="Views">
                    {viewRows(WORKSPACE_VIEWS)}
                  </CommandGroup>
                  {actions.length > 0 && (
                    <CommandGroup heading="Actions">
                      {actionRows(actions)}
                    </CommandGroup>
                  )}
                  <CommandGroup heading={`Create in ${activeProjectName}`}>
                    <CreateRow
                      value="create-task"
                      label="New task"
                      query=""
                      onRun={() => run(() => onCreateTask(""))}
                    />
                    <CreateRow
                      value="create-note"
                      label="New note"
                      query=""
                      onRun={() => run(() => onCreateNote(""))}
                    />
                    <CreateRow
                      value="create-automation"
                      label="New automation"
                      query=""
                      onRun={() => run(() => onCreateAutomation(""))}
                    />
                    <CreateRow
                      value="create-project"
                      label="New project"
                      query=""
                      onRun={() => run(() => onCreateProject(""))}
                    />
                  </CommandGroup>
                </>
              ) : noMatches ? (
                <CommandGroup heading="Create">
                  <CreateRow
                    value="create-task"
                    label="New task"
                    query={trimmed}
                    onRun={() => run(() => onCreateTask(trimmed))}
                  />
                  <CreateRow
                    value="create-note"
                    label="New note"
                    query={trimmed}
                    onRun={() => run(() => onCreateNote(trimmed))}
                  />
                  <CreateRow
                    value="create-automation"
                    label="New automation"
                    query={trimmed}
                    onRun={() => run(() => onCreateAutomation(trimmed))}
                  />
                  <CreateRow
                    value="create-project"
                    label="New project"
                    query={trimmed}
                    onRun={() => run(() => onCreateProject(trimmed))}
                  />
                </CommandGroup>
              ) : (
                <>
                  {/* Navigation first: a query that matches a project or view
                      name is a strong navigation intent, so these rank above
                      content matches (and cmdk auto-selects the top one). */}
                  {rankedProjects.length > 0 && (
                    <CommandGroup heading="Jump to">
                      {projectRows(rankedProjects)}
                    </CommandGroup>
                  )}
                  {rankedViews.length > 0 && (
                    <CommandGroup heading="Views">
                      {viewRows(rankedViews)}
                    </CommandGroup>
                  )}
                  {rankedActions.length > 0 && (
                    <CommandGroup heading="Actions">
                      {actionRows(rankedActions)}
                    </CommandGroup>
                  )}
                  {rankedTasks.length > 0 && (
                    <CommandGroup heading="Tasks">
                      {rankedTasks.map((t) => (
                        <CommandItem
                          key={t.path}
                          value={`task:${t.path}`}
                          onSelect={() => run(() => onOpenTask(t.path))}
                        >
                          <RowIcon>
                            <Columns2Icon className="size-4" />
                          </RowIcon>
                          <span className="truncate">{t.title}</span>
                          {t.meta && <CommandMeta>{t.meta}</CommandMeta>}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {rankedNotes.length > 0 && (
                    <CommandGroup heading="Notes">
                      {rankedNotes.map((n) => (
                        <CommandItem
                          key={n.slug}
                          value={`note:${n.slug}`}
                          onSelect={() => run(() => onOpenNote(n.slug))}
                        >
                          <RowIcon>
                            <FileTextIcon className="size-4" />
                          </RowIcon>
                          <span className="truncate">{n.title}</span>
                          {n.meta && <CommandMeta>{n.meta}</CommandMeta>}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {rankedAutomations.length > 0 && (
                    <CommandGroup heading="Automations">
                      {rankedAutomations.map((automation) => (
                        <CommandItem
                          key={automation.path}
                          value={`automation:${automation.path}`}
                          onSelect={() =>
                            run(() => onOpenAutomation(automation.path))
                          }
                        >
                          <RowIcon>
                            <BotIcon className="size-4" />
                          </RowIcon>
                          <span className="truncate">{automation.title}</span>
                          {automation.meta && (
                            <CommandMeta>{automation.meta}</CommandMeta>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </>
              )}
            </CommandList>

            {/* Key-hint footer bar. */}
            <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <kbd className="text-foreground">↑↓</kbd> navigate
              </span>
              <span className="flex items-center gap-1.5">
                <CornerDownLeftIcon className="size-3" /> open
              </span>
              <span className="ml-auto flex items-center gap-1">
                <kbd className="text-foreground">⌘K</kbd>
              </span>
            </div>
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
