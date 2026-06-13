"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
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
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertCircleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CoffeeIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderSyncIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { parseFrontmatter, setFrontmatterKeys } from "@/lib/frontmatter";
import {
  clearChatFields,
  harnessLabel,
  parseChatOpenState,
  parseChatRef,
  parseChatStatus,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { sha256 } from "@/lib/hash";
import {
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type ProjectStatus,
} from "@/lib/projectConfig";
import { taskBodyPath, taskSlug, uniqueSlug } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { TaskDialog, type TaskTarget } from "@/components/TaskDialog";
import { HarnessChip } from "@/components/HarnessChip";
import {
  GlobalSettingsDialog,
  type GlobalHarnessSetupStatus,
  type GlobalSettingsTab,
  type HarnessHookStatus,
} from "@/components/GlobalSettingsDialog";
import {
  ProjectDetailsDialog,
  type DetailsTab as ProjectDetailsTab,
} from "@/components/ProjectDetailsDialog";
import { UpdateBanner } from "@/components/UpdateBanner";
import { Button } from "@/components/ui/button";
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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

// Default status columns for old projects and for new projects before custom
// statuses are saved. Task files still store the normalized status id string in
// `status` frontmatter.
const DEFAULT_STATUSES = [
  { id: "todo", name: "To Do" },
  { id: "in-progress", name: "In Progress" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
] as const satisfies ProjectStatus[];

function statusesForProject(
  statuses: ProjectStatus[] | undefined,
): ProjectStatus[] {
  return statuses?.length ? statuses : [...DEFAULT_STATUSES];
}

function columnFor(
  status: string | undefined,
  statuses: ProjectStatus[],
): string {
  const s = (status ?? "").toLowerCase();
  if (s === "blocked" && statuses.some((col) => col.id === "review")) {
    return "review";
  }
  return statuses.some((col) => col.id === s) ? s : statuses[0].id;
}

interface Card {
  id: string; // `tasks/${slug}` — the task folder
  slug: string;
  title: string;
  owner?: string;
  path: string; // tasks/<slug>/task.md — what the dialog writes back
  content: string; // raw file text
  chat: ChatRef | null; // the coding-agent chat driving this task, if linked
  chatStatus: ChatStatus | null; // live working/ready state, if the chat reports it
  chatOpenState: ChatOpenState | null; // whether the chat link is safe to open
  column: string;
  archived: boolean;
  updatedAt: number;
}

interface ProjectNavEntry {
  project: {
    _id: Id<"projects">;
    name: string;
    statuses?: ProjectStatus[];
  };
  membership: {
    role: "owner" | "member";
  } | null;
  pinned: boolean;
  pinnedOrder: number | null;
}

interface Viewer {
  name: string | null;
  email: string | null;
  image: string | null;
}

interface HitchBinding {
  projectId: Id<"projects">;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

interface LocalHitchConfig {
  hitches: HitchBinding[];
}

interface DeviceAuthState {
  deviceId: string;
  deviceName: string;
  hostname: string;
  hasToken: boolean;
}

interface KeepAwakeState {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  error: string | null;
}

interface HarnessSettingsApi {
  getGlobalHarnessSetup: () => Promise<GlobalHarnessSetupStatus>;
}

interface KeepAwakeApi {
  getKeepAwakeState: () => Promise<KeepAwakeState>;
  startKeepAwake: () => Promise<KeepAwakeState>;
  stopKeepAwake: () => Promise<KeepAwakeState>;
  onKeepAwakeState: (callback: (state: KeepAwakeState) => void) => () => void;
}

function harnessSetupBridge(): HarnessSettingsApi | undefined {
  return typeof window !== "undefined"
    ? (window.hitchDaemon as unknown as HarnessSettingsApi | undefined)
    : undefined;
}

function keepAwakeBridge(): KeepAwakeApi | undefined {
  return typeof window !== "undefined"
    ? (window.hitchDaemon as unknown as KeepAwakeApi | undefined)
    : undefined;
}

function harnessStatusText(status: HarnessHookStatus | null): string {
  if (status === null) return "Checking";
  if (status.installed) return "Configured";
  if (status.scriptExists || status.configHasHook) return "Needs repair";
  return "Not configured";
}

// Shared card chrome, also reused by the drag overlay so the floating element
// matches the one in the column.
const CARD_CLASS =
  "rounded-sm bg-card p-3 text-left shadow-[0_1px_1px_rgba(0,0,0,0.03)] ring-[0.75px] ring-border/70";

function CardSummary({ card }: { card: Card }) {
  return (
    <p className="text-[13px] font-normal text-card-foreground">{card.title}</p>
  );
}

function CardChat({
  card,
  projectId,
}: {
  card: Card;
  projectId: Id<"projects">;
}) {
  if (!card.chat) return null;

  return (
    <div className="mt-3">
      <HarnessChip
        chat={card.chat}
        status={card.chatStatus}
        openState={card.chatOpenState}
        projectId={projectId}
      />
    </div>
  );
}

function CardContents({
  card,
  projectId,
}: {
  card: Card;
  projectId: Id<"projects">;
}) {
  return (
    <>
      <CardSummary card={card} />
      {card.chat && <CardChat card={card} projectId={projectId} />}
    </>
  );
}

function isInteractiveTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactiveTarget = target.closest(
    'button, a, input, select, textarea, [role="button"], [role="link"], [data-card-drag-ignore]',
  );
  return interactiveTarget !== null && interactiveTarget !== currentTarget;
}

function WindowDragRegion() {
  return <div className="window-drag-region" aria-hidden />;
}

function SignInScreen() {
  const { signIn } = useAuthActions();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startGitHubSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      await signIn("github");
    } catch (err) {
      setError(String(err));
      setSigningIn(false);
    }
  }

  return (
    <>
      <WindowDragRegion />
      <main className="flex min-h-screen items-center justify-center p-8 pt-14">
        <section className="flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Sign in to Hitch
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Use GitHub to open your live project board.
            </p>
          </div>
          <Button onClick={startGitHubSignIn} disabled={signingIn}>
            <ExternalLinkIcon />
            {signingIn ? "Opening GitHub..." : "Continue with GitHub"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </section>
      </main>
    </>
  );
}

// A small modal for creating a project. Opened by the "+" in the PROJECTS
// header; replaces the old inline new-project form. Commits on submit, then
// closes and clears so the next open starts fresh.
function CreateProjectDialog({
  open,
  onOpenChange,
  creating,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creating: boolean;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");

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

const MORE_COLLAPSED_KEY = "hitch:sidebar:more-collapsed";

function AppSidebar({
  projects,
  selectedProjectId,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onOpenProjectSettings,
  harnessSetup,
  keepAwake,
  onToggleKeepAwake,
  onShowGlobalSettings,
  onSignOut,
}: {
  projects: ProjectNavEntry[];
  selectedProjectId: Id<"projects">;
  creatingProject: boolean;
  onSelectProject: (projectId: Id<"projects">) => void;
  onCreateProject: (name: string) => Promise<void>;
  onOpenProjectSettings: (projectId: Id<"projects">) => void;
  harnessSetup: GlobalHarnessSetupStatus | null;
  keepAwake: KeepAwakeState | null;
  onToggleKeepAwake: () => void;
  onShowGlobalSettings: (tab?: GlobalSettingsTab) => void;
  onSignOut: () => void;
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
    <aside className="window-sidebar flex shrink-0 items-center gap-3 border-b bg-sidebar px-3 pb-2 pt-10 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-64 md:flex-col md:items-stretch md:border-b-0 md:border-r md:border-sidebar-border md:px-3 md:pb-4 md:pt-12">
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
          keepAwake={keepAwake}
          onToggleKeepAwake={onToggleKeepAwake}
          onShowGlobalSettings={onShowGlobalSettings}
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
  keepAwake,
  onToggleKeepAwake,
  onShowGlobalSettings,
  onSignOut,
}: {
  harnessSetup: GlobalHarnessSetupStatus | null;
  keepAwake: KeepAwakeState | null;
  onToggleKeepAwake: () => void;
  onShowGlobalSettings: (tab?: GlobalSettingsTab) => void;
  onSignOut: () => void;
}) {
  const viewer = useQuery(api.users.viewer);
  const repairs = harnessesNeedingRepair(harnessSetup);
  const needsRepair = repairs.length > 0;
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
        <UserAvatar viewer={viewer} sizeClass="size-6.5" dot={needsRepair} />
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
              key={status.harness}
              onClick={() => onShowGlobalSettings("harnesses")}
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
          <MenuItem onClick={() => onShowGlobalSettings("harnesses")}>
            <CheckCircle2Icon className="text-emerald-500" />
            <span className="flex-1 text-popover-foreground/80">Harnesses</span>
            <span className="text-[11.5px] text-muted-foreground">
              All configured
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
        <MenuItem onClick={onSignOut}>
          <LogOutIcon />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function AppShell({
  projects,
  selectedProjectId,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onOpenProjectSettings,
  harnessSetup,
  keepAwake,
  onToggleKeepAwake,
  onShowGlobalSettings,
  onSignOut,
  children,
}: {
  projects: ProjectNavEntry[];
  selectedProjectId: Id<"projects">;
  creatingProject: boolean;
  onSelectProject: (projectId: Id<"projects">) => void;
  onCreateProject: (name: string) => Promise<void>;
  onOpenProjectSettings: (projectId: Id<"projects">) => void;
  harnessSetup: GlobalHarnessSetupStatus | null;
  keepAwake: KeepAwakeState | null;
  onToggleKeepAwake: () => void;
  onShowGlobalSettings: (tab?: GlobalSettingsTab) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell relative flex h-screen flex-col overflow-hidden bg-background md:flex-row">
      <AppSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        creatingProject={creatingProject}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onOpenProjectSettings={onOpenProjectSettings}
        harnessSetup={harnessSetup}
        keepAwake={keepAwake}
        onToggleKeepAwake={onToggleKeepAwake}
        onShowGlobalSettings={onShowGlobalSettings}
        onSignOut={onSignOut}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col p-4 pt-3 sm:p-6 sm:pt-3 lg:p-8 lg:pt-3">
        {children}
      </main>
    </div>
  );
}

function NoProjectWelcome({
  creatingProject,
  onCreateProject,
  onSignOut,
}: {
  creatingProject: boolean;
  onCreateProject: (name: string) => Promise<void>;
  onSignOut: () => void;
}) {
  const [showCreateProject, setShowCreateProject] = useState(false);

  return (
    <>
      <WindowDragRegion />
      <main className="flex min-h-screen items-center justify-center bg-background p-6 pt-14">
        <section className="flex w-full max-w-md flex-col gap-5 rounded-lg border bg-card p-6 shadow-sm">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Welcome to Hitch
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Create your first project
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Projects are now driven by your Hitch account. Create one, then
              bind it to a local folder when you are ready to sync task files.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setShowCreateProject(true)}>
              <PlusIcon />
              Create project
            </Button>
            <Button variant="ghost" onClick={onSignOut}>
              <LogOutIcon />
              Sign out
            </Button>
          </div>
        </section>
        <CreateProjectDialog
          open={showCreateProject}
          onOpenChange={setShowCreateProject}
          creating={creatingProject}
          onCreate={onCreateProject}
        />
      </main>
    </>
  );
}

function AuthenticatedBoard() {
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (isLoading) {
    return (
      <>
        <WindowDragRegion />
        <main className="flex min-h-screen items-center justify-center bg-background p-6 pt-14 text-muted-foreground">
          Checking session…
        </main>
      </>
    );
  }

  if (!isAuthenticated) return <SignInScreen />;

  return <ProjectWorkspace />;
}

function ProjectWorkspace() {
  const { signOut } = useAuthActions();
  const bridge = typeof window !== "undefined" ? window.hitchDaemon : undefined;
  const projects = useQuery(api.projects.listMine);
  const createProjectMutation = useMutation(api.projects.create);
  const authorizeDevice = useMutation(api.deviceTokens.authorizeDevice);
  const [selectedProjectId, setSelectedProjectId] =
    useState<Id<"projects"> | null>(null);
  const [localConfig, setLocalConfig] = useState<LocalHitchConfig | null>(null);
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthState | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  useEffect(() => {
    if (!bridge) {
      setLocalConfig({ hitches: [] });
      return;
    }
    void bridge.getConfig().then((config) => {
      setLocalConfig(config);
    });
    void bridge.getDeviceAuth().then(setDeviceAuth);
  }, [bridge]);

  useEffect(() => {
    if (!bridge || deviceAuth === null || deviceAuth.hasToken) return;
    void authorizeDevice({
      deviceId: deviceAuth.deviceId,
      name: deviceAuth.deviceName || "This Mac",
      hostname: deviceAuth.hostname,
    }).then(async (result) => {
      if (result.token) {
        setDeviceAuth(await bridge.setDeviceToken(result.token));
      } else {
        setDeviceAuth(await bridge.getDeviceAuth());
      }
    });
  }, [authorizeDevice, bridge, deviceAuth]);

  useEffect(() => {
    if (projects === undefined) return;
    if (projects.length === 0) {
      if (selectedProjectId !== null) setSelectedProjectId(null);
      return;
    }
    if (
      !selectedProjectId ||
      !projects.some(({ project }) => project._id === selectedProjectId)
    ) {
      setSelectedProjectId(projects[0].project._id);
    }
  }, [projects, selectedProjectId]);

  function selectProject(projectId: Id<"projects">) {
    setSelectedProjectId(projectId);
  }

  async function createProject(name: string) {
    setCreatingProject(true);
    try {
      const project = await createProjectMutation({ name });
      if (project) selectProject(project._id);
    } finally {
      setCreatingProject(false);
    }
  }

  if (projects === undefined) {
    return (
      <>
        <WindowDragRegion />
        <main className="flex min-h-screen items-center justify-center bg-background p-6 pt-14 text-muted-foreground">
          Loading projects…
        </main>
      </>
    );
  }

  if (projects.length === 0) {
    return (
      <NoProjectWelcome
        creatingProject={creatingProject}
        onCreateProject={createProject}
        onSignOut={() => void signOut()}
      />
    );
  }

  const selectedProject =
    projects.find(({ project }) => project._id === selectedProjectId)
      ?.project ?? null;

  if (!selectedProject) {
    return (
      <>
        <WindowDragRegion />
        <main className="flex min-h-screen items-center justify-center bg-background p-6 pt-14 text-muted-foreground">
          Opening project…
        </main>
      </>
    );
  }

  return (
    <BoardContent
      projectId={selectedProject._id}
      projects={projects}
      creatingProject={creatingProject}
      onSelectProject={selectProject}
      onCreateProject={createProject}
      localConfig={localConfig}
      onLocalConfigChange={setLocalConfig}
    />
  );
}

interface DraggableCardProps {
  card: Card;
  projectId: Id<"projects">;
  pending: boolean;
  onOpen: (card: Card) => void;
  onArchiveToggle: (card: Card, archived: boolean) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

// A board card that can be picked up from any non-interactive surface (left-drag,
// 1px threshold so a plain click still opens it) and dropped on another column.
// Right-click keeps the existing archive/delete menu — PointerSensor ignores
// non-primary buttons, so the menu and dragging don't fight. Defined at module
// scope (not inside Board) so it isn't a fresh component type each render, which
// would remount mid-drag.
function DraggableCard({
  card,
  projectId,
  pending,
  onOpen,
  onArchiveToggle,
  onDuplicate,
  onDelete,
}: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
  });
  const dragListeners = useMemo(() => {
    return Object.fromEntries(
      Object.entries(listeners ?? {}).map(([eventName, listener]) => [
        eventName,
        (event: SyntheticEvent) => {
          if (isInteractiveTarget(event.target, event.currentTarget)) return;
          listener(event);
        },
      ]),
    );
  }, [listeners]);

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          ref={setNodeRef}
          {...attributes}
          {...dragListeners}
          role="button"
          tabIndex={0}
          onClick={(event) => {
            if (isInteractiveTarget(event.target, event.currentTarget)) return;
            onOpen(card);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (isInteractiveTarget(event.target, event.currentTarget)) return;
            event.preventDefault();
            onOpen(card);
          }}
          className={cn(
            CARD_CLASS,
            "group relative cursor-default transition-shadow hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
            isDragging && "opacity-40",
          )}
        >
          <CardSummary card={card} />
          <CardChat card={card} projectId={projectId} />
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
        <ContextMenuItem disabled={pending} onClick={() => onDuplicate(card)}>
          <CopyIcon />
          Duplicate
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

// A single row in the archived sheet: the task's title/path plus inline
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
          {card.path}
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
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setConfirmingDeleteAll(false);
        onOpenChange(nextOpen);
      }}
    >
      <ArchivedSheetContent
        cards={cards}
        confirmingDeleteAll={confirmingDeleteAll}
        pendingCardId={pendingCardId}
        onUnarchive={onUnarchive}
        onDelete={onDelete}
        onDeleteAll={onDeleteAll}
        onConfirmingDeleteAllChange={setConfirmingDeleteAll}
      />
    </Sheet>
  );
}

function ArchivedSheetContent({
  cards,
  confirmingDeleteAll,
  pendingCardId,
  onUnarchive,
  onDelete,
  onDeleteAll,
  onConfirmingDeleteAllChange,
}: {
  cards: Card[];
  confirmingDeleteAll: boolean;
  pendingCardId: string | null;
  onUnarchive: (card: Card) => void;
  onDelete: (card: Card) => void;
  onDeleteAll: () => void;
  onConfirmingDeleteAllChange: (confirming: boolean) => void;
}) {
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
                onConfirmingDeleteAllChange(false);
              } else {
                onConfirmingDeleteAllChange(true);
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
function TaskComposer({
  onCreate,
  onClose,
}: {
  onCreate: (title: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
        className="w-full bg-transparent text-[13px] font-normal text-card-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// A column that accepts dropped cards. Its droppable id IS the status value, so
// the drop handler can read the destination status straight off `over.id`.
function DroppableColumn({
  status,
  count,
  onAdd,
  onArchiveAll,
  onDeleteAll,
  children,
}: {
  status: ProjectStatus;
  count: number;
  onAdd: () => void;
  onArchiveAll: () => void;
  onDeleteAll: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  // "Delete all" arms on first click (the menu item swaps to a confirm label)
  // and fires on the second — mirroring the per-card archive shortcut and the
  // archived sheet's delete-all. Reset whenever the menu closes so a half-armed
  // column never lingers.
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  return (
    <section
      ref={setNodeRef}
      className="relative flex w-[18rem] shrink-0 flex-col gap-3 rounded-[12px] bg-muted/60 p-3 transition-colors dark:bg-muted"
    >
      <div className="relative z-20 flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-[13px] font-medium text-foreground/80">
          {status.name}
          <span className="font-normal text-muted-foreground">{count}</span>
        </h2>
        <div className="flex items-center gap-0.5">
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
          {count > 0 && (
            <Menu
              onOpenChange={(open) => {
                if (!open) setConfirmingDeleteAll(false);
              }}
            >
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Column actions"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onClick={onArchiveAll}>
                  <ArchiveIcon />
                  Archive all · {count}
                </MenuItem>
                <MenuItem
                  closeOnClick={confirmingDeleteAll}
                  onClick={() => {
                    if (!confirmingDeleteAll) {
                      setConfirmingDeleteAll(true);
                      return;
                    }
                    onDeleteAll();
                  }}
                  className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
                >
                  <Trash2Icon />
                  {confirmingDeleteAll
                    ? `Click again to delete ${count}`
                    : `Delete all · ${count}`}
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>
      <div className="-m-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-1">
        {children}
        {count === 0 && (
          <p className="px-1 text-xs text-muted-foreground/70">No tasks</p>
        )}
      </div>

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

function BoardContent({
  projectId,
  projects,
  creatingProject,
  onSelectProject,
  onCreateProject,
  localConfig,
  onLocalConfigChange,
}: {
  projectId: Id<"projects">;
  projects: ProjectNavEntry[];
  creatingProject: boolean;
  onSelectProject: (projectId: Id<"projects">) => void;
  onCreateProject: (name: string) => Promise<void>;
  localConfig: LocalHitchConfig | null;
  onLocalConfigChange: (config: LocalHitchConfig) => void;
}) {
  const { signOut } = useAuthActions();
  const currentProject = projects.find(
    ({ project }) => project._id === projectId,
  )?.project;
  const files = useQuery(api.files.listFiles, { projectId });
  const ensureProjectConfig = useMutation(api.projects.ensureProjectConfig);
  // Optimistically patch the cached file so a drag/archive/delete — and a brand
  // new task — reflects instantly instead of waiting on the frontmatter →
  // daemon → Convex round trip. Bumping updatedAt lands the card at the top of
  // its (destination) column, matching how the server-stamped value will sort
  // once it settles. A create hits the same path: no row matches the key, so we
  // append a fabricated one (real _id arrives when the daemon round-trips).
  const upsertFile = useMutation(api.files.upsertFile).withOptimisticUpdate(
    (localStore, args) => {
      const existing = localStore.getQuery(api.files.listFiles, {
        projectId: args.projectId,
      });
      if (existing === undefined) return;
      type FileDoc = (typeof existing)[number];
      const idx = existing.findIndex((f) => f.path === args.path);
      const base: FileDoc =
        idx >= 0
          ? existing[idx]
          : ({
              _id: `optimistic:${args.path}` as FileDoc["_id"],
              _creationTime: Number.MAX_SAFE_INTEGER,
              projectId: "" as FileDoc["projectId"],
              path: args.path,
              content: "",
              hash: "",
              deleted: false,
              updatedAt: Number.MAX_SAFE_INTEGER,
            } satisfies FileDoc);
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
        { projectId: args.projectId },
        next,
      );
    },
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalSettingsTab, setGlobalSettingsTab] =
    useState<GlobalSettingsTab>("harnesses");
  const [globalHarnessSetup, setGlobalHarnessSetup] =
    useState<GlobalHarnessSetupStatus | null>(null);
  const [keepAwake, setKeepAwake] = useState<KeepAwakeState | null>(null);
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [projectDetailsTab, setProjectDetailsTab] =
    useState<ProjectDetailsTab>("general");
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which column, if any, has its inline "new task" composer open.
  const [composingCol, setComposingCol] = useState<string | null>(null);
  const projectConfigFile = files?.find(
    (file) => file.path === PROJECT_CONFIG_PATH && !file.deleted,
  );
  const projectConfig = useMemo(
    () => parseProjectConfig(projectConfigFile?.content, projectId),
    [projectConfigFile?.content, projectId],
  );
  const boardStatuses = useMemo(
    () =>
      statusesForProject(
        projectConfig?.tasks?.statuses?.length
          ? projectConfig.tasks.statuses
          : currentProject?.statuses,
      ),
    [currentProject?.statuses, projectConfig?.tasks?.statuses],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 1 } }),
  );
  const localConfigReady = localConfig !== null;
  const projectIsHitched = Boolean(
    localConfig?.hitches.some(
      (hitch) => hitch.projectId === projectId && hitch.enabled !== false,
    ),
  );

  function openProjectDetails(tab: ProjectDetailsTab = "general") {
    setProjectDetailsTab(tab);
    setShowProjectDetails(true);
  }

  // Open settings for a project from the sidebar context menu: select it first
  // (the details dialog is bound to the active project) then open the dialog.
  function openProjectSettingsFor(targetProjectId: Id<"projects">) {
    if (targetProjectId !== projectId) onSelectProject(targetProjectId);
    openProjectDetails();
  }

  function openGlobalSettings(tab: GlobalSettingsTab = "harnesses") {
    setGlobalSettingsTab(tab);
    setShowGlobalSettings(true);
  }

  useEffect(() => {
    const bridge = harnessSetupBridge();
    if (!bridge) return;
    void bridge
      .getGlobalHarnessSetup()
      .then(setGlobalHarnessSetup)
      .catch(() => {
        setGlobalHarnessSetup(null);
      });
  }, []);

  useEffect(() => {
    const bridge = keepAwakeBridge();
    if (!bridge) {
      setKeepAwake(null);
      return;
    }

    let alive = true;
    void bridge
      .getKeepAwakeState()
      .then((state) => {
        if (alive) setKeepAwake(state);
      })
      .catch(() => {
        if (alive) setKeepAwake(null);
      });

    const unsubscribe = bridge.onKeepAwakeState((state) => {
      setKeepAwake(state);
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!currentProject || files === undefined) return;
    if (projectConfig) return;
    void ensureProjectConfig({ projectId }).catch(() => {
      // The board can still render from project-row status metadata during
      // migration, so a backfill failure should not block the workspace.
    });
  }, [
    currentProject,
    ensureProjectConfig,
    files,
    projectConfig,
    projectConfigFile,
    projectId,
  ]);

  async function toggleKeepAwake() {
    const bridge = keepAwakeBridge();
    if (!bridge) return;
    const next = keepAwake?.enabled
      ? await bridge.stopKeepAwake()
      : await bridge.startKeepAwake();
    setKeepAwake(next);
  }

  // `C` arms the composer on the first column for keyboard-driven creation.
  // Ignored while typing in a field or with the editor open, and when chorded
  // with a modifier (so browser shortcuts like ⌘C still work).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (selectedPath) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      ) {
        return;
      }
      e.preventDefault();
      setComposingCol(boardStatuses[0].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boardStatuses, selectedPath]);

  if (!currentProject || files === undefined) {
    return (
      <AppShell
        projects={projects}
        selectedProjectId={projectId}
        creatingProject={creatingProject}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onOpenProjectSettings={openProjectSettingsFor}
        harnessSetup={globalHarnessSetup}
        keepAwake={keepAwake}
        onToggleKeepAwake={() => void toggleKeepAwake()}
        onShowGlobalSettings={openGlobalSettings}
        onSignOut={() => void signOut()}
      >
        <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
          Connecting to Convex...
        </div>
        <GlobalSettingsDialog
          open={showGlobalSettings}
          onOpenChange={setShowGlobalSettings}
          initialTab={globalSettingsTab}
          onLocalConfigChange={onLocalConfigChange}
          onHarnessSetupChange={setGlobalHarnessSetup}
        />
        <ProjectDetailsDialog
          projectId={projectId}
          open={showProjectDetails}
          onOpenChange={setShowProjectDetails}
          onLocalConfigChange={onLocalConfigChange}
          initialTab={projectDetailsTab}
        />
      </AppShell>
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
        id: `tasks/${slug}`,
        slug,
        title: frontmatter.title || slug,
        owner: frontmatter.owner,
        path: f.path,
        content: f.content,
        chat: parseChatRef(frontmatter),
        chatStatus: parseChatStatus(frontmatter),
        chatOpenState: parseChatOpenState(frontmatter),
        column: columnFor(status, boardStatuses),
        archived: status === "archived",
        updatedAt: f.updatedAt,
      });
      return acc;
    }, [])
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeCards = cards.filter((card) => !card.archived);
  const archivedCards = cards.filter((card) => card.archived);
  const byColumn = Object.fromEntries(
    boardStatuses.map((c) => [
      c.id,
      activeCards.filter((card) => card.column === c.id),
    ]),
  ) as Record<string, Card[]>;

  const selected = selectedPath
    ? (cards.find((card) => card.path === selectedPath) ?? null)
    : null;
  const target: TaskTarget | null = selected && {
    projectId,
    path: selected.path,
    title: selected.title,
    content: selected.content,
  };

  // Create a task by writing a fresh `tasks/<slug>/task.md` through the same
  // upsert path everything else uses; the daemon writes the file and the live
  // query renders the card (instantly, via the optimistic insert above).
  async function createTask(column: string, title: string) {
    const taken = new Set(cards.map((card) => card.slug));
    const slug = uniqueSlug(title, taken);
    const content = setFrontmatterKeys("", { title, status: column });
    await upsertFile({
      projectId,
      path: taskBodyPath(slug),
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  // Duplicate a task: write a fresh `tasks/<slug>/task.md` that keeps the
  // original body, status, and other frontmatter, but with a "COPY OF: …" title
  // and the source's coding-chat link cleared so the copy starts un-linked. Same
  // upsert path as createTask — the live query renders the new card instantly via
  // the optimistic insert.
  async function duplicateTask(card: Card) {
    const taken = new Set(cards.map((c) => c.slug));
    const title = `COPY OF: ${card.title}`;
    const slug = uniqueSlug(title, taken);
    const content = setFrontmatterKeys(clearChatFields(card.content), {
      title,
    });
    await upsertFile({
      projectId,
      path: taskBodyPath(slug),
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  async function setArchived(card: Card, archived: boolean) {
    const { frontmatter } = parseFrontmatter(card.content);
    const restoreStatus = columnFor(frontmatter.archivedFrom, boardStatuses);
    const nextContent = setFrontmatterKeys(card.content, {
      status: archived ? "archived" : restoreStatus,
      archivedFrom: archived ? card.column : undefined,
    });

    setPendingCardId(card.id);
    try {
      await upsertFile({
        projectId,
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
        projectId,
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
          projectId,
          path: card.path,
          content: "",
          hash: "",
          deleted: true,
        }),
      ),
    );
  }

  // Archive every card in one column at once. Same frontmatter rewrite as the
  // archive branch of `setArchived` (status → "archived", remembering the source
  // column in `archivedFrom` so Unarchive restores it), fired concurrently so
  // the column empties immediately via the optimistic update.
  async function archiveAllInColumn(columnCards: Card[]) {
    await Promise.all(
      columnCards.map(async (card) => {
        const nextContent = setFrontmatterKeys(card.content, {
          status: "archived",
          archivedFrom: card.column,
        });
        await upsertFile({
          projectId,
          path: card.path,
          content: nextContent,
          hash: await sha256(nextContent),
          deleted: false,
        });
      }),
    );
  }

  // Permanently delete every card in one column. Mirrors `deleteAllArchived`,
  // sliced to a single column — the tombstone path each card already uses.
  async function deleteAllInColumn(columnCards: Card[]) {
    await Promise.all(
      columnCards.map((card) =>
        upsertFile({
          projectId,
          path: card.path,
          content: "",
          hash: "",
          deleted: true,
        }),
      ),
    );
  }

  // Move a card to another column by rewriting just its `status` frontmatter.
  // Chat lifecycle fields are owned by the harness hooks, so a board move
  // should never reset or replay them from this card snapshot.
  async function setStatus(card: Card, status: string) {
    const nextContent = setFrontmatterKeys(card.content, { status });

    setPendingCardId(card.id);
    try {
      await upsertFile({
        projectId,
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
    const dest = String(over.id);
    if (!boardStatuses.some((status) => status.id === dest)) return;
    if (!card || (card.column === dest && !card.archived)) return;
    void setStatus(card, dest);
  }

  const activeCard = activeId
    ? (cards.find((c) => c.id === activeId) ?? null)
    : null;

  return (
    <AppShell
      projects={projects}
      selectedProjectId={projectId}
      creatingProject={creatingProject}
      onSelectProject={onSelectProject}
      onCreateProject={onCreateProject}
      onOpenProjectSettings={openProjectSettingsFor}
      harnessSetup={globalHarnessSetup}
      keepAwake={keepAwake}
      onToggleKeepAwake={() => void toggleKeepAwake()}
      onShowGlobalSettings={openGlobalSettings}
      onSignOut={() => void signOut()}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <header className="window-titlebar-row -mx-4 -mt-3 flex h-12 shrink-0 flex-nowrap items-center justify-end gap-3 overflow-hidden border-b border-border bg-background px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openProjectDetails()}
            >
              <SettingsIcon />
              Project settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={archivedCards.length === 0}
              onClick={() => setShowArchived(true)}
            >
              <ArchiveIcon />
              Archived
              {archivedCards.length > 0 && (
                <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {archivedCards.length}
                </span>
              )}
            </Button>
          </div>
        </header>

        {localConfigReady && !projectIsHitched && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-amber-500/10 p-3 text-sm">
            <div className="flex min-w-0 items-start gap-2">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <p className="font-medium">
                  This project is not hitched locally.
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Link it to your repo folder before launching coding harnesses.
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openProjectDetails("local")}
            >
              <FolderSyncIcon />
              Open local setup
            </Button>
          </section>
        )}

        <DndContext
          sensors={sensors}
          onDragStart={(event: DragStartEvent) =>
            setActiveId(String(event.active.id))
          }
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="-mx-4 flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            {boardStatuses.map((col) => (
              <DroppableColumn
                key={col.id}
                status={col}
                count={byColumn[col.id].length}
                onAdd={() => setComposingCol(col.id)}
                onArchiveAll={() => void archiveAllInColumn(byColumn[col.id])}
                onDeleteAll={() => void deleteAllInColumn(byColumn[col.id])}
              >
                {composingCol === col.id && (
                  <TaskComposer
                    onCreate={(title) => void createTask(col.id, title)}
                    onClose={() => setComposingCol(null)}
                  />
                )}
                {byColumn[col.id].map((card) => (
                  <DraggableCard
                    key={card.id}
                    card={card}
                    projectId={projectId}
                    pending={pendingCardId === card.id}
                    onOpen={(card) => setSelectedPath(card.path)}
                    onArchiveToggle={(c, archived) =>
                      void setArchived(c, archived)
                    }
                    onDuplicate={(c) => void duplicateTask(c)}
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
                <CardContents card={activeCard} projectId={projectId} />
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

        <GlobalSettingsDialog
          open={showGlobalSettings}
          onOpenChange={setShowGlobalSettings}
          initialTab={globalSettingsTab}
          onLocalConfigChange={onLocalConfigChange}
          onHarnessSetupChange={setGlobalHarnessSetup}
        />

        <ProjectDetailsDialog
          projectId={projectId}
          open={showProjectDetails}
          onOpenChange={setShowProjectDetails}
          onLocalConfigChange={onLocalConfigChange}
          initialTab={projectDetailsTab}
        />

        <TaskDialog
          task={target}
          onOpenChange={(open) => {
            if (!open) setSelectedPath(null);
          }}
          onArchive={selected ? () => void setArchived(selected, true) : undefined}
          onDelete={selected ? () => void deleteCard(selected) : undefined}
          onManagePrompts={() => openGlobalSettings("starting-prompts")}
          onManageHarnesses={() => openGlobalSettings("harnesses")}
        />
      </div>
    </AppShell>
  );
}

export default function Board() {
  return <AuthenticatedBoard />;
}
