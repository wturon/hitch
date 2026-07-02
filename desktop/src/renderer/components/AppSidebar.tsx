import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
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
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  BugIcon,
  ChevronUpIcon,
  CoffeeIcon,
  FlaskConicalIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  StarIcon,
} from "lucide-react";
import { harnessLabel } from "@/lib/chat";
import { cn } from "@/lib/utils";
import type { KeepAwakeState, ProjectNavEntry, Viewer } from "@/lib/types";
import {
  type IntegrationHealth,
  type IntegrationStatus,
  type GlobalHarnessSetupStatus,
  type GlobalSettingsTab,
  type HarnessHookStatus,
} from "@/components/GlobalSettingsDialog";
import { UpdateBanner } from "@/components/UpdateBanner";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";

const MORE_COLLAPSED_KEY = "hitch:sidebar:more-collapsed";

// A small modal for creating a project. Opened by the "+" in the PROJECTS
// header; replaces the old inline new-project form. Commits on submit, then
// closes and clears so the next open starts fresh.
export function CreateProjectDialog({
  open,
  onOpenChange,
  creating,
  onCreate,
  initialName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creating: boolean;
  onCreate: (name: string) => Promise<void>;
  // Pre-fills the field when opened — the command palette passes the typed query
  // for its "New project “<query>”" create row.
  initialName?: string;
}) {
  const [name, setName] = useState(initialName ?? "");

  // Re-seed the field each time the dialog opens (the palette may carry a fresh
  // query); also clears it after a create closes the dialog.
  useEffect(() => {
    if (open) setName(initialName ?? "");
  }, [open, initialName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await onCreate(trimmed);
    setName("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Create a project and switch to its board.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <label className="sr-only" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project name"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// At-a-glance chat activity for one project in the sidebar: a grey spinner +
// count for tasks whose chat is mid-turn ("working"), and an amber dot + count
// for tasks blocked on the human ("needs-input") — so a noisy project that needs
// you stands out without leaving the rail. A fully idle project shows a faint
// dash so the trailing lane stays consistent; while counts are still loading we
// render nothing (the dash would otherwise flash on every project). The amber
// treatment mirrors the "Needs repair" harness shortcut below.
function ProjectStatusChips({
  counts,
}: {
  counts: { working: number; needsInput: number } | undefined;
}) {
  if (!counts) return null;
  const { working, needsInput } = counts;
  if (working === 0 && needsInput === 0) {
    return (
      <span className="text-xs text-sidebar-foreground/35" aria-hidden>
        —
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {working > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 text-xs font-semibold text-sidebar-foreground/70"
          title={`${working} chat${working === 1 ? "" : "s"} working`}
        >
          <LoaderCircleIcon className="size-3 animate-spin" />
          {working}
        </span>
      )}
      {needsInput > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300"
          title={`${needsInput} task${needsInput === 1 ? "" : "s"} need${needsInput === 1 ? "s" : ""} input`}
        >
          <span className="size-1.5 rounded-full bg-amber-500" />
          {needsInput}
        </span>
      )}
    </div>
  );
}

function harnessStatusText(status: HarnessHookStatus | null): string {
  if (status === null) return "Checking";
  if (status.installed) return "Configured";
  if (status.scriptExists || status.configHasHook) return "Needs repair";
  return "Not configured";
}

// Harnesses that are mid-repair (a hook script/config exists but isn't fully
// installed) — the only state that earns the amber attention treatment.
// Never-configured harnesses stay quiet (no nag), per the design.
function harnessesNeedingRepair(
  setup: GlobalHarnessSetupStatus | null,
): HarnessHookStatus[] {
  if (!setup) return [];
  return [setup.codex, setup.claudeCode].filter(
    (status) => harnessStatusText(status) === "Needs repair",
  );
}

function integrationsNeedingAttention(
  health: IntegrationHealth | null,
): IntegrationStatus[] {
  if (!health) return [];
  return health.integrations.filter(
    (integration) =>
      integration.applies &&
      integration.state !== "ok" &&
      integration.state !== "quiet",
  );
}

// A round avatar for the signed-in user: their GitHub image when present, else
// a monogram from the first letter of their name/email. Optionally carries an
// amber attention dot (used on the resting account row when a harness needs
// repair). Monochrome grey gradient keeps it in the rail's neutral palette.
function UserAvatar({
  viewer,
  sizeClass,
  dot = false,
}: {
  viewer: Viewer | null | undefined;
  sizeClass: string;
  dot?: boolean;
}) {
  const letter = (viewer?.name || viewer?.email || "?").trim().charAt(0) || "?";
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white",
        sizeClass,
      )}
      style={{ backgroundImage: "linear-gradient(140deg, #595959, #8a8a8a)" }}
    >
      {viewer?.image ? (
        <img src={viewer.image} alt="" className="size-full object-cover" />
      ) : (
        letter.toUpperCase()
      )}
      {dot && (
        <span className="absolute -bottom-px -right-px size-2.5 rounded-full border-2 border-sidebar-accent bg-amber-500" />
      )}
    </span>
  );
}

// One project in the rail: a muted `#` glyph in a fixed slot, the project name
// at card-title weight, and a trailing slot that shows the at-a-glance status
// chip at rest and swaps to a pin toggle on hover (Codex-style). Right-clicking
// opens a context menu (Pin/Unpin + Project settings). `drag` carries the
// dnd-kit sortable wiring for pinned rows; it's absent for MORE/flat rows.
function ProjectRow({
  entry,
  selected,
  counts,
  onSelect,
  onTogglePin,
  onOpenProjectSettings,
  drag,
}: {
  entry: ProjectNavEntry;
  selected: boolean;
  counts: { working: number; needsInput: number } | undefined;
  onSelect: (projectId: Id<"projects">) => void;
  onTogglePin: (entry: ProjectNavEntry) => void;
  onOpenProjectSettings: (projectId: Id<"projects">) => void;
  drag?: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: CSSProperties;
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown> | undefined;
    dragging: boolean;
  };
}) {
  const pinned = entry.pinned;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={drag?.setNodeRef}
        style={drag?.style}
        {...drag?.attributes}
        {...drag?.listeners}
        className={cn(
          "group/row flex min-h-9 items-center gap-2 rounded-lg pr-1.5 pl-2 transition-colors",
          selected
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
          drag?.dragging && "opacity-50",
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(entry.project._id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        >
          <span
            className={cn(
              "w-4 shrink-0 text-center font-mono text-[15px] leading-none",
              selected
                ? "text-sidebar-foreground/70"
                : "text-sidebar-foreground/40",
            )}
            aria-hidden
          >
            #
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-normal">
            {entry.project.name}
          </span>
        </button>
        {/* Fixed-width trailing slot: the status chip fades out (opacity, no
            layout shift) and the pin fades in as an absolutely-positioned
            overlay covering the slot. Keeping the footprint constant — rather
            than display-swapping chip↔pin at different widths — means the
            cursor never falls into a reflow gap (which flickered hover on/off)
            and gives the pin a generous, stable hit area on the row's right. */}
        <div className="relative flex h-7 min-w-9 shrink-0 items-center justify-end">
          <div className="flex items-center group-hover/row:opacity-0">
            <ProjectStatusChips counts={counts} />
          </div>
          <button
            type="button"
            aria-label={pinned ? "Unpin project" : "Pin project"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(entry);
            }}
            className="pointer-events-none absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-md text-sidebar-foreground/55 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/row:pointer-events-auto group-hover/row:opacity-100"
          >
            <PinIcon className={cn("size-3.5", pinned && "fill-current")} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onTogglePin(entry)}>
          <PinIcon className={cn(pinned && "fill-current")} />
          {pinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onOpenProjectSettings(entry.project._id)}
        >
          <SettingsIcon />
          Project settings
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// A pinned row wrapped in dnd-kit sortable wiring so the PINNED group can be
// manually drag-reordered. MORE/flat rows render <ProjectRow> directly.
function SortablePinnedRow({
  entry,
  selected,
  counts,
  onSelect,
  onTogglePin,
  onOpenProjectSettings,
}: {
  entry: ProjectNavEntry;
  selected: boolean;
  counts: { working: number; needsInput: number } | undefined;
  onSelect: (projectId: Id<"projects">) => void;
  onTogglePin: (entry: ProjectNavEntry) => void;
  onOpenProjectSettings: (projectId: Id<"projects">) => void;
}) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } =
    useSortable({ id: entry.project._id });
  return (
    <ProjectRow
      entry={entry}
      selected={selected}
      counts={counts}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onOpenProjectSettings={onOpenProjectSettings}
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

export function AppSidebar({
  projects,
  selectedProjectId,
  creatingProject,
  collapsed,
  onSelectProject,
  onCreateProject,
  onOpenProjectSettings,
  harnessSetup,
  integrationHealth,
  keepAwake,
  onToggleKeepAwake,
  onShowGlobalSettings,
  onShowDebug,
  onShowEditorSandbox,
  onSignOut,
  onOpenPalette,
}: {
  projects: ProjectNavEntry[];
  selectedProjectId: Id<"projects">;
  creatingProject: boolean;
  collapsed: boolean;
  onSelectProject: (projectId: Id<"projects">) => void;
  onCreateProject: (name: string) => Promise<void>;
  onOpenProjectSettings: (projectId: Id<"projects">) => void;
  harnessSetup: GlobalHarnessSetupStatus | null;
  integrationHealth: IntegrationHealth | null;
  keepAwake: KeepAwakeState | null;
  onToggleKeepAwake: () => void;
  onShowGlobalSettings: (tab?: GlobalSettingsTab) => void;
  onShowDebug?: () => void;
  onShowEditorSandbox?: () => void;
  onSignOut: () => void;
  // Open the global command palette (⌘K). The sidebar's search bar is just a
  // discoverable, clickable entry point to it.
  onOpenPalette: () => void;
}) {
  const [showCreateProject, setShowCreateProject] = useState(false);
  // Reactive per-project working / needs-input tallies. Aggregated server-side
  // (see api.files.chatStatusCounts) so we never subscribe to other projects'
  // full file contents. Convex dedups this subscription across renders.
  const statusCounts = useQuery(api.files.chatStatusCounts);

  // Pin state is per-user and server-side (projectMembers), synced across
  // devices. Optimistic updates keep the rail snappy: a pin/unpin/reorder
  // reflects instantly by patching the cached listMine before the round trip.
  const setPinned = useMutation(api.projects.setPinned).withOptimisticUpdate(
    (store, args) => {
      const list = store.getQuery(api.projects.listMine, {});
      if (!list) return;
      const maxOrder = list.reduce(
        (max, entry) =>
          entry.pinned && entry.pinnedOrder != null
            ? Math.max(max, entry.pinnedOrder)
            : max,
        -1,
      );
      store.setQuery(
        api.projects.listMine,
        {},
        list.map((entry) =>
          entry.project._id === args.projectId
            ? {
                ...entry,
                pinned: args.pinned,
                pinnedOrder: args.pinned ? maxOrder + 1 : null,
              }
            : entry,
        ),
      );
    },
  );
  const reorderPinned = useMutation(
    api.projects.reorderPinned,
  ).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.projects.listMine, {});
    if (!list) return;
    const orderIndex = new Map(args.projectIds.map((id, index) => [id, index]));
    store.setQuery(
      api.projects.listMine,
      {},
      list.map((entry) =>
        orderIndex.has(entry.project._id)
          ? { ...entry, pinnedOrder: orderIndex.get(entry.project._id)! }
          : entry,
      ),
    );
  });

  function togglePin(entry: ProjectNavEntry) {
    void setPinned({ projectId: entry.project._id, pinned: !entry.pinned });
  }

  const pinned = useMemo(
    () =>
      projects
        .filter((entry) => entry.pinned)
        .sort(
          (a, b) =>
            (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0) ||
            a.project.name.localeCompare(b.project.name),
        ),
    [projects],
  );
  // listMine already returns entries alphabetically, so MORE stays A–Z.
  const more = useMemo(
    () => projects.filter((entry) => !entry.pinned),
    [projects],
  );
  const hasPins = pinned.length > 0;
  const pinnedIds = useMemo(
    () => pinned.map((entry) => entry.project._id),
    [pinned],
  );

  // MORE collapse persists per-device and defaults collapsed. The active
  // project is always kept visible: if it lives in a collapsed MORE we surface
  // just its row beneath the header, so collapsing never hides where you are.
  const [moreCollapsed, setMoreCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MORE_COLLAPSED_KEY) !== "false";
  });
  useEffect(() => {
    window.localStorage.setItem(
      MORE_COLLAPSED_KEY,
      moreCollapsed ? "true" : "false",
    );
  }, [moreCollapsed]);
  const activeInMore =
    more.find((entry) => entry.project._id === selectedProjectId) ?? null;

  const sidebarSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function onPinnedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = pinnedIds.indexOf(active.id as Id<"projects">);
    const newIndex = pinnedIds.indexOf(over.id as Id<"projects">);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(pinnedIds, oldIndex, newIndex);
    void reorderPinned({ projectIds: next });
  }

  function renderRow(entry: ProjectNavEntry) {
    return (
      <ProjectRow
        key={entry.project._id}
        entry={entry}
        selected={entry.project._id === selectedProjectId}
        counts={statusCounts?.[entry.project._id]}
        onSelect={onSelectProject}
        onTogglePin={togglePin}
        onOpenProjectSettings={onOpenProjectSettings}
      />
    );
  }

  return (
    <aside
      className={cn(
        "window-sidebar flex shrink-0 items-center gap-3 border-b bg-sidebar px-3 pb-2 pt-10 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-64 md:flex-col md:items-stretch md:border-b-0 md:border-r md:border-sidebar-border md:px-3 md:pb-4 md:pt-12",
        // Desktop collapse: the rail keeps its width but slides off-canvas via
        // a negative margin, so `main` (flex-1) reclaims the space without the
        // content squishing mid-animation. app-shell's overflow-hidden clips
        // the off-screen rail. Mobile (the horizontal bar) is unaffected.
        "md:transition-[margin] md:duration-200 md:ease-in-out",
        collapsed && "md:-ml-64",
      )}
    >
      {/* Search bar — a discoverable, clickable entry point to the ⌘K palette.
          Desktop rail only (the mobile bar omits it), and a no-drag button so
          it stays clickable over the draggable titlebar region. */}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search — open command palette"
        className="mb-2 hidden h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-2.5 text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:flex"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        <span className="flex-1 text-left text-[13px]">Search…</span>
        <KbdGroup>
          <Kbd className="bg-sidebar-foreground/10 text-sidebar-foreground/55">
            ⌘
          </Kbd>
          <Kbd className="bg-sidebar-foreground/10 text-sidebar-foreground/55">
            K
          </Kbd>
        </KbdGroup>
      </button>

      <nav className="hidden flex-1 flex-col gap-0.5 overflow-auto md:flex">
        <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-sidebar-foreground/50">
            Projects
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShowCreateProject(true)}
                  aria-label="New project"
                  className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent>New project</TooltipContent>
          </Tooltip>
        </div>

        {projects.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sidebar-foreground/55">
            No projects yet.
          </p>
        ) : !hasPins ? (
          // Zero pinned → a plain flat list, no PINNED/MORE headers.
          projects.map(renderRow)
        ) : (
          <>
            <div className="flex items-center gap-1.5 px-2 pb-1 pt-0.5">
              <StarIcon className="size-3 shrink-0 fill-sidebar-foreground/30 text-sidebar-foreground/30" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/50">
                Pinned
              </span>
            </div>
            <DndContext
              sensors={sidebarSensors}
              onDragEnd={onPinnedDragEnd}
            >
              <SortableContext
                items={pinnedIds}
                strategy={verticalListSortingStrategy}
              >
                {pinned.map((entry) => (
                  <SortablePinnedRow
                    key={entry.project._id}
                    entry={entry}
                    selected={entry.project._id === selectedProjectId}
                    counts={statusCounts?.[entry.project._id]}
                    onSelect={onSelectProject}
                    onTogglePin={togglePin}
                    onOpenProjectSettings={onOpenProjectSettings}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {more.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setMoreCollapsed((value) => !value)}
                  className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-sidebar-accent/50"
                >
                  {moreCollapsed ? (
                    <ChevronRightIcon className="size-3 shrink-0 text-sidebar-foreground/55" />
                  ) : (
                    <ChevronDownIcon className="size-3 shrink-0 text-sidebar-foreground/55" />
                  )}
                  <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/50">
                    More
                  </span>
                  <span className="text-[11px] font-medium text-sidebar-foreground/35">
                    {more.length}
                  </span>
                </button>
                {moreCollapsed
                  ? activeInMore && renderRow(activeInMore)
                  : more.map(renderRow)}
              </>
            )}
          </>
        )}
      </nav>

      <CreateProjectDialog
        open={showCreateProject}
        onOpenChange={setShowCreateProject}
        creating={creatingProject}
        onCreate={onCreateProject}
      />

      <div className="ml-auto flex items-center gap-1 md:ml-0 md:mt-auto md:flex-col md:items-stretch md:border-t md:border-sidebar-border md:pt-2">
        <UpdateBanner />
        <AccountFooter
          harnessSetup={harnessSetup}
          integrationHealth={integrationHealth}
          keepAwake={keepAwake}
          onToggleKeepAwake={onToggleKeepAwake}
          onShowGlobalSettings={onShowGlobalSettings}
          onShowDebug={onShowDebug}
          onShowEditorSandbox={onShowEditorSandbox}
          onSignOut={onSignOut}
        />
      </div>
    </aside>
  );
}

// The rail's footer identity control: a resting row (avatar + name + a passive
// coffee icon only when keep-awake is on + chevron) that opens an upward
// popover consolidating harness health, the keep-awake toggle, Settings, and
// Sign out. Replaces the old stacked shortcut buttons. An amber dot appears on
// the resting avatar (and an amber Fix row in the popover) only when a harness
// needs repair.
function AccountFooter({
  harnessSetup,
  integrationHealth,
  keepAwake,
  onToggleKeepAwake,
  onShowGlobalSettings,
  onShowDebug,
  onShowEditorSandbox,
  onSignOut,
}: {
  harnessSetup: GlobalHarnessSetupStatus | null;
  integrationHealth: IntegrationHealth | null;
  keepAwake: KeepAwakeState | null;
  onToggleKeepAwake: () => void;
  onShowGlobalSettings: (tab?: GlobalSettingsTab) => void;
  onShowDebug?: () => void;
  onShowEditorSandbox?: () => void;
  onSignOut: () => void;
}) {
  const viewer = useQuery(api.users.viewer);
  const repairs = integrationsNeedingAttention(integrationHealth);
  const legacyRepairs =
    integrationHealth === null ? harnessesNeedingRepair(harnessSetup) : [];
  const needsRepair = repairs.length > 0;
  const needsLegacyRepair = legacyRepairs.length > 0;
  const awakeOn = keepAwake?.enabled === true;
  const awakeUnavailable = keepAwake === null;
  const name = viewer?.name || viewer?.email || "Account";

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Account"
            className="flex min-h-10 w-full items-center gap-2.5 rounded-lg bg-sidebar-accent px-2 py-1.5 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-accent/80"
          />
        }
      >
        <UserAvatar
          viewer={viewer}
          sizeClass="size-6.5"
          dot={needsRepair || needsLegacyRepair}
        />
        <span className="hidden min-w-0 flex-1 truncate text-[13px] font-medium md:inline">
          {name}
        </span>
        {awakeOn && (
          <CoffeeIcon className="hidden size-3.5 shrink-0 text-sidebar-foreground/55 md:block" />
        )}
        <ChevronUpIcon className="hidden size-3.5 shrink-0 text-sidebar-foreground/55 md:block" />
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[var(--anchor-width)] min-w-56 p-1.5"
      >
        <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
          <UserAvatar viewer={viewer} sizeClass="size-7.5" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-semibold text-popover-foreground">
              {viewer?.name || "Account"}
            </span>
            {viewer?.email && (
              <span className="truncate text-[11.5px] text-muted-foreground">
                {viewer.email}
              </span>
            )}
          </div>
        </div>

        <div className="my-0.5 h-px bg-border" />

        {needsRepair ? (
          repairs.map((status) => (
            <MenuItem
              key={status.id}
              onClick={() => onShowGlobalSettings("integrations")}
              className="h-auto items-center border border-amber-500/30 bg-amber-500/10 py-1.5 text-amber-700 data-highlighted:bg-amber-500/15 data-highlighted:text-amber-800 dark:text-amber-300 dark:data-highlighted:text-amber-200"
            >
              <AlertCircleIcon className="text-amber-600 dark:text-amber-400" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium">
                  {status.group}
                </span>
                <span className="text-[11.5px] opacity-80">
                  {status.label} needs repair
                </span>
              </div>
              <span className="shrink-0 rounded-md border border-amber-500/40 bg-background px-2 py-0.5 text-[11.5px] font-semibold">
                Fix
              </span>
            </MenuItem>
          ))
        ) : needsLegacyRepair ? (
          legacyRepairs.map((status) => (
            <MenuItem
              key={status.harness}
              onClick={() => onShowGlobalSettings("integrations")}
              className="h-auto items-center border border-amber-500/30 bg-amber-500/10 py-1.5 text-amber-700 data-highlighted:bg-amber-500/15 data-highlighted:text-amber-800 dark:text-amber-300 dark:data-highlighted:text-amber-200"
            >
              <AlertCircleIcon className="text-amber-600 dark:text-amber-400" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium">
                  {harnessLabel(status.harness)}
                </span>
                <span className="text-[11.5px] opacity-80">
                  Hooks need repair
                </span>
              </div>
              <span className="shrink-0 rounded-md border border-amber-500/40 bg-background px-2 py-0.5 text-[11.5px] font-semibold">
                Fix
              </span>
            </MenuItem>
          ))
        ) : (
          <MenuItem onClick={() => onShowGlobalSettings("integrations")}>
            <CheckCircle2Icon className="text-emerald-500" />
            <span className="flex-1 text-popover-foreground/80">Integrations</span>
            <span className="text-[11.5px] text-muted-foreground">
              Healthy
            </span>
          </MenuItem>
        )}

        <MenuItem
          closeOnClick={false}
          disabled={awakeUnavailable}
          onClick={onToggleKeepAwake}
          aria-pressed={awakeOn}
        >
          <CoffeeIcon />
          <span className="flex-1">Keep machine awake</span>
          <span
            aria-hidden
            className={cn(
              "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
              awakeOn ? "bg-foreground" : "bg-foreground/25",
            )}
          >
            <span
              className={cn(
                "size-3 rounded-full bg-background shadow-sm transition-transform",
                awakeOn && "translate-x-3",
              )}
            />
          </span>
        </MenuItem>

        <div className="my-1 h-px bg-border" />

        <MenuItem onClick={() => onShowGlobalSettings()}>
          <SettingsIcon />
          Settings
        </MenuItem>
        {onShowDebug ? (
          <MenuItem onClick={onShowDebug}>
            <BugIcon />
            Debug
          </MenuItem>
        ) : null}
        {onShowEditorSandbox ? (
          <MenuItem onClick={onShowEditorSandbox}>
            <FlaskConicalIcon />
            Editor Sandbox
          </MenuItem>
        ) : null}
        <MenuItem onClick={onSignOut}>
          <LogOutIcon />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
