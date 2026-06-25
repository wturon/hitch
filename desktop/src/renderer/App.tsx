"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
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
  Code2Icon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderSyncIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  SettingsIcon,
  SunIcon,
  SunMoonIcon,
  Trash2Icon,
} from "lucide-react";
import { parseFrontmatter, setFrontmatterKeys } from "@/lib/frontmatter";
import {
  clearChatFields,
  parseChatOpenState,
  parseChatRef,
  parseChatStatus,
} from "@/lib/chat";
import { sha256 } from "@/lib/hash";
import {
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type ProjectStatus,
} from "@/lib/projectConfig";
import {
  isKnownStatusId,
  statusNameFromId,
  statusFrontmatterLine,
  statusesForProject,
} from "@/lib/statuses";
import { taskBodyPath, taskSlug, uniqueSlug } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { TaskDialog, type TaskTarget } from "@/components/TaskDialog";
import { NotesView, noteDocs, type NoteIntent } from "@/components/NotesView";
import { ChatsView } from "@/components/ChatsView";
import { AutomationsView } from "@/components/AutomationsView";
import {
  CommandPalette,
  WORKSPACE_VIEWS,
  type PaletteAction,
  type WorkspaceView,
} from "@/components/CommandPalette";
import {
  useAutomationActions,
  useAutomationDefinitions,
} from "@/hooks/useAutomations";
import {
  CARD_CLASS,
  CardChat,
  CardContents,
  CardSummary,
  type Card,
} from "@/components/TaskCard";
import {
  GlobalSettingsDialog,
  type GlobalHarnessSetupStatus,
  type GlobalSettingsTab,
} from "@/components/GlobalSettingsDialog";
import {
  ProjectDetailsDialog,
  type DetailsTab as ProjectDetailsTab,
} from "@/components/ProjectDetailsDialog";
import { AppSidebar, CreateProjectDialog } from "@/components/AppSidebar";
import { ProjectConflictDialog } from "@/components/ProjectConflictDialog";
import {
  StatusMigrationDialog,
  type StatusMigrationRequest,
} from "@/components/StatusMigrationDialogs";
import type { KeepAwakeState, ProjectNavEntry } from "@/lib/types";
import { UpdateBanner } from "@/components/UpdateBanner";
import { getStoredTheme, setTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
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
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

function columnFor(
  status: string | undefined,
  statuses: ProjectStatus[],
): string {
  const s = (status ?? "").toLowerCase();
  return isKnownStatusId(s, statuses) ? s : statuses[0].id;
}

function boardColumnFor(
  status: string | undefined,
  statuses: ProjectStatus[],
): string {
  const s = (status ?? "").toLowerCase();
  if (!s) return statuses[0].id;
  return isKnownStatusId(s, statuses) ? s : s;
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

type BoardFocusColumn = {
  id: string;
  cardIds: string[];
};

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
}

function findFocusedBoardCardId(
  cardNodes: Map<string, HTMLDivElement>,
): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  for (const [cardId, node] of cardNodes) {
    if (node === active) return cardId;
  }
  return null;
}

function firstBoardCardId(columns: BoardFocusColumn[]): string | null {
  for (const column of columns) {
    if (column.cardIds.length > 0) return column.cardIds[0];
  }
  return null;
}

function nextBoardCardId(
  columns: BoardFocusColumn[],
  currentCardId: string | null,
  key: string,
): string | null {
  if (!currentCardId) return firstBoardCardId(columns);

  const columnIndex = columns.findIndex((column) =>
    column.cardIds.includes(currentCardId),
  );
  if (columnIndex < 0) return firstBoardCardId(columns);

  const column = columns[columnIndex];
  const rowIndex = column.cardIds.indexOf(currentCardId);
  if (key === "ArrowUp") {
    return column.cardIds[Math.max(0, rowIndex - 1)] ?? currentCardId;
  }
  if (key === "ArrowDown") {
    return (
      column.cardIds[Math.min(column.cardIds.length - 1, rowIndex + 1)] ??
      currentCardId
    );
  }

  const step = key === "ArrowLeft" ? -1 : 1;
  for (
    let i = columnIndex + step;
    i >= 0 && i < columns.length;
    i += step
  ) {
    const candidateColumn = columns[i];
    if (candidateColumn.cardIds.length === 0) continue;
    return (
      candidateColumn.cardIds[
        Math.min(rowIndex, candidateColumn.cardIds.length - 1)
      ] ?? null
    );
  }
  return currentCardId;
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

// Collapse persists per-device and defaults expanded, mirroring the theme /
// MORE prefs. The whole rail (not the MORE section) is what this toggles.
const SIDEBAR_COLLAPSED_KEY = "hitch:sidebar:collapsed";

// The rail toggle. Pinned to the window's top-left strip just right of the
// macOS traffic lights (main.ts trafficLightPosition x:14), so it survives the
// rail sliding off-canvas and "stays up there" in both states. Desktop only —
// the mobile layout uses the horizontal bar and isn't collapsible. The global
// `button { -webkit-app-region: no-drag }` rule keeps it clickable over the
// draggable titlebar.
function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={!collapsed}
            className="fixed left-[78px] top-2 z-[60] hidden size-7 items-center justify-center rounded-md text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:flex"
          />
        }
      >
        <PanelLeftIcon className="size-4" />
      </TooltipTrigger>
      <TooltipContent>
        {collapsed ? "Open sidebar" : "Close sidebar"} ⌘\
      </TooltipContent>
    </Tooltip>
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
  onOpenPalette,
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
  onOpenPalette: () => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  });
  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_KEY,
      collapsed ? "true" : "false",
    );
  }, [collapsed]);

  // ⌘\ (Ctrl+\ on Windows/Linux) toggles the rail. Unlike the board's `c`
  // shortcut this fires even while typing, since it's a chrome-level control
  // and `\` chorded with a modifier never produces text.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "\\") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setCollapsed((value) => !value);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="app-shell relative flex h-screen flex-col overflow-hidden bg-background md:flex-row"
      data-sidebar-collapsed={collapsed ? "true" : undefined}
    >
      <AppSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        creatingProject={creatingProject}
        collapsed={collapsed}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onOpenProjectSettings={onOpenProjectSettings}
        harnessSetup={harnessSetup}
        keepAwake={keepAwake}
        onToggleKeepAwake={onToggleKeepAwake}
        onShowGlobalSettings={onShowGlobalSettings}
        onSignOut={onSignOut}
        onOpenPalette={onOpenPalette}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-3 pb-0 sm:px-6 sm:pt-3 sm:pb-0 lg:px-8 lg:pt-3 lg:pb-0">
        {children}
      </main>
      {/* Rendered last so its `no-drag` region is subtracted AFTER the sidebar
          and titlebar `drag` regions are unioned — Electron resolves overlapping
          app-regions in DOM order, so an earlier no-drag would be re-covered by
          a later sibling drag region and the OS would swallow the clicks. */}
      <SidebarToggle
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
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
  registerCardNode: (cardId: string, node: HTMLDivElement | null) => void;
  onOpen: (card: Card) => void;
  onArchiveToggle: (card: Card, archived: boolean) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

function copyTaskPath(card: Card) {
  void navigator.clipboard.writeText(`.hitch/${card.path}`).catch(() => {
    // Clipboard can be unavailable (e.g. no permission); silently ignore.
  });
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
  registerCardNode,
  onOpen,
  onArchiveToggle,
  onDuplicate,
  onDelete,
}: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
  });
  const setCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      registerCardNode(card.id, node);
    },
    [card.id, registerCardNode, setNodeRef],
  );
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
          ref={setCardRef}
          {...attributes}
          {...dragListeners}
          data-board-card-id={card.id}
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
        <ContextMenuItem disabled={pending} onClick={() => copyTaskPath(card)}>
          <CopyIcon />
          Copy path
        </ContextMenuItem>
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
  isRenaming,
  onTitleClick,
  onRename,
  onRenameCommit,
  onCopyStatusId,
  onManageStatuses,
  onDeleteStatus,
  onArchiveAll,
  onDeleteAll,
  children,
}: {
  status: ProjectStatus;
  count: number;
  onAdd: () => void;
  isRenaming: boolean;
  onTitleClick: () => void;
  onRename: () => void;
  onRenameCommit: (name: string) => void;
  onCopyStatusId: () => void;
  onManageStatuses: () => void;
  onDeleteStatus: () => void;
  onArchiveAll: () => void;
  onDeleteAll: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const [renameValue, setRenameValue] = useState(status.name);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const cancelledRename = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setRenameValue(status.name);
  }, [status.id, status.name]);

  useEffect(() => {
    if (!isRenaming) return;
    const input = renameInputRef.current;
    if (!input) return;
    cancelledRename.current = false;
    input.focus();
    input.select();
  }, [isRenaming]);

  function commitRename() {
    if (cancelledRename.current) {
      setRenameValue(status.name);
      onRenameCommit(status.name);
      return;
    }
    const trimmed = renameValue.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      setRenameValue(status.name);
      onRenameCommit(status.name);
      return;
    }
    onRenameCommit(trimmed);
  }

  function onRenameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelledRename.current = true;
      setRenameValue(status.name);
      event.currentTarget.blur();
    }
  }

  return (
    <section
      ref={setNodeRef}
      className="relative flex w-[18rem] shrink-0 flex-col gap-3 rounded-[12px] bg-muted/60 p-3 transition-colors dark:bg-muted"
    >
      <div className="relative z-20 flex items-center justify-between px-1">
        <h2 className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={commitRename}
              onKeyDown={onRenameKeyDown}
              aria-label={`Rename status ${status.name}`}
              spellCheck={false}
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <button
              type="button"
              onClick={onTitleClick}
              className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] font-medium text-foreground/80 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 truncate">{status.name}</span>
              <span className="shrink-0 font-normal text-muted-foreground">
                {count}
              </span>
            </button>
          )}
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
            <MenuContent align="end" className="min-w-52">
              <MenuItem onClick={onRename}>
                <PencilIcon />
                Rename
              </MenuItem>
              <MenuItem onClick={onCopyStatusId}>
                <CopyIcon />
                <span className="min-w-0 flex-1">Copy id</span>
                <span className="ml-2 max-w-24 truncate font-mono text-xs text-muted-foreground">
                  {status.id}
                </span>
              </MenuItem>
              <MenuItem onClick={onManageStatuses}>
                <SettingsIcon />
                Manage statuses…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onClick={onDeleteStatus}
                className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
              >
                <Trash2Icon />
                Delete status
              </MenuItem>
              {count > 0 && (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={onArchiveAll}>
                    <ArchiveIcon />
                    Archive all cards · {count}
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
                      ? `Click again to delete ${count} cards`
                      : `Delete all cards · ${count}`}
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
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

function UnknownStatusColumn({
  statusId,
  count,
  onAddAsStatus,
  onMoveCards,
  children,
}: {
  statusId: string;
  count: number;
  onAddAsStatus: () => void;
  onMoveCards: () => void;
  children: ReactNode;
}) {
  return (
    <section className="relative flex w-[18rem] shrink-0 flex-col gap-3 rounded-[12px] border border-dashed border-amber-300/80 bg-amber-50/70 p-3 text-amber-950 dark:border-amber-400/40 dark:bg-amber-950/20 dark:text-amber-100">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
          <AlertCircleIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <span className="min-w-0 truncate">Unknown</span>
          <span className="shrink-0 font-normal text-amber-700 dark:text-amber-300">
            {count}
          </span>
        </h2>
        <code className="max-w-28 truncate rounded bg-amber-100 px-1.5 py-1 font-mono text-[11px] text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
          {statusId}
        </code>
      </div>

      <div className="rounded-md border border-amber-200/80 bg-background/75 p-2.5 text-xs leading-5 text-foreground shadow-sm dark:border-amber-400/30 dark:bg-background/80">
        <p>
          These cards use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {statusFrontmatterLine(statusId)}
          </code>
          , which isn't a status in this project.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={onAddAsStatus}>
            Add "{statusId}" as a status
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onMoveCards}
          >
            Move cards to…
          </Button>
        </div>
      </div>

      <div className="-m-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-1">
        {children}
      </div>
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
  const updateStatuses = useMutation(api.projects.updateStatuses);
  const renameStatusWithMigration = useMutation(
    api.projects.renameStatusWithMigration,
  );
  const deleteStatusWithMigration = useMutation(
    api.projects.deleteStatusWithMigration,
  );
  const moveCardsWithStatus = useMutation(api.projects.moveCardsWithStatus);
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
  // Attachment rows for the project (image blobs live outside `files`). We only
  // need them to drive the delete cascade: when a task is removed, tombstone its
  // attachment rows so the daemon cleans up the local files + empty folders.
  const attachments = useQuery(api.attachments.listAttachments, { projectId });
  const tombstoneAttachment = useMutation(api.attachments.tombstoneAttachment);
  const duplicateTaskWithAttachments = useAction(
    api.attachments.duplicateTaskWithAttachments,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // The Notes view's Archived sheet, opened from the same top-right header slot.
  const [showNotesArchived, setShowNotesArchived] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalSettingsTab, setGlobalSettingsTab] =
    useState<GlobalSettingsTab>("harnesses");
  const [globalHarnessSetup, setGlobalHarnessSetup] =
    useState<GlobalHarnessSetupStatus | null>(null);
  const [keepAwake, setKeepAwake] = useState<KeepAwakeState | null>(null);
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [projectDetailsTab, setProjectDetailsTab] =
    useState<ProjectDetailsTab>("general");
  const [statusMigrationRequest, setStatusMigrationRequest] =
    useState<StatusMigrationRequest | null>(null);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [renamingStatusId, setRenamingStatusId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which column, if any, has its inline "new task" composer open.
  const [composingCol, setComposingCol] = useState<string | null>(null);
  // Per-project tab: the Kanban board, or the Notes two-pane view.
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("board");
  // The global command palette (⌘K) and its one-shot request to NotesView to
  // open/create a note. A palette-driven "New project" reuses the sidebar's
  // CreateProjectDialog, pre-filled with the typed query.
  const [showPalette, setShowPalette] = useState(false);
  const [noteIntent, setNoteIntent] = useState<NoteIntent | null>(null);
  const [automationIntent, setAutomationIntent] = useState<string | null>(null);
  const [createProjectName, setCreateProjectName] = useState<string | null>(
    null,
  );
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
  const boardFocusColumnsRef = useRef<BoardFocusColumn[]>([]);
  const boardCardNodesRef = useRef(new Map<string, HTMLDivElement>());
  const registerBoardCardNode = useCallback(
    (cardId: string, node: HTMLDivElement | null) => {
      if (node) boardCardNodesRef.current.set(cardId, node);
      else boardCardNodesRef.current.delete(cardId);
    },
    [],
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

  useEffect(() => {
    if (
      renamingStatusId !== null &&
      !boardStatuses.some((status) => status.id === renamingStatusId)
    ) {
      setRenamingStatusId(null);
    }
  }, [boardStatuses, renamingStatusId]);

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight"
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (workspaceView !== "board" || selectedPath || composingCol) return;
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="menu"]',
        )
      ) {
        return;
      }
      if (isTextEditingTarget(e.target)) return;

      const columns = boardFocusColumnsRef.current;
      if (columns.length === 0) return;

      const cardNodes = boardCardNodesRef.current;
      const focusedCardId = findFocusedBoardCardId(cardNodes);
      const nextCardId = nextBoardCardId(columns, focusedCardId, e.key);
      if (!nextCardId) return;

      const nextNode = cardNodes.get(nextCardId);
      if (!nextNode) return;

      e.preventDefault();
      nextNode.focus();
      nextNode.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composingCol, selectedPath, workspaceView]);

  // ⌘K (Ctrl+K) toggles the command palette. When it's already open, close it
  // (the footer advertises ⌘K). When closed, suppress only where ⌘K means
  // something else or the palette shouldn't appear: the MDX editor
  // (contenteditable — it owns ⌘K for inserting links) or while another dialog/
  // menu is up (incl. the task dialog). Plain text fields are NOT suppressed —
  // the Notes view keeps its search input focused, and ⌘K must still open there.
  // Base UI restores focus to the previously-focused element on close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      if (showPalette) {
        e.preventDefault();
        setShowPalette(false);
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable) return;
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="menu"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      setShowPalette(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPalette]);

  // Switch the per-project view from the keyboard, mirroring a browser's tabs:
  // ⌘1…⌘N (Ctrl on Windows/Linux) jumps to a view by position, and
  // Ctrl+Tab / Ctrl+Shift+Tab cycles forward/back with wraparound. Ctrl+Tab
  // stays on Ctrl across platforms (⌘Tab is the OS app switcher). Both are
  // chrome-level like ⌘\ and fire even while typing — modifier chords never
  // produce text, and leaving Notes mid-edit unmounts NotesView, whose unmount
  // flush saves the open draft — so we only bail when a dialog/menu overlay
  // (palette, task dialog, context menu) owns the keyboard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const overlayUp = !!document.querySelector(
        '[role="dialog"],[role="alertdialog"],[role="menu"]',
      );

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle to the next / previous view.
      if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
        if (overlayUp) return;
        e.preventDefault();
        const step = e.shiftKey ? -1 : 1;
        setWorkspaceView((prev) => {
          const n = WORKSPACE_VIEWS.length;
          const i = WORKSPACE_VIEWS.findIndex((v) => v.view === prev);
          return WORKSPACE_VIEWS[(i + step + n) % n].view;
        });
        return;
      }

      // ⌘1…⌘N (Ctrl+1…N) — jump straight to the view at that position. A number
      // past the last view (e.g. ⌘3 today) is left alone, not swallowed.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        /^[1-9]$/.test(e.key)
      ) {
        const idx = Number(e.key) - 1;
        if (idx >= WORKSPACE_VIEWS.length || overlayUp) return;
        e.preventDefault();
        setWorkspaceView(WORKSPACE_VIEWS[idx].view);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { automations: automationRecords } = useAutomationDefinitions(projectId, {
    includeInvalid: true,
  });
  const automationActions = useAutomationActions(projectId, files ?? []);

  if (!currentProject || files === undefined) {
    boardFocusColumnsRef.current = [];
  }

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
        onOpenPalette={() => setShowPalette(true)}
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
        sourceNote: frontmatter["source-note"] || undefined,
        column: boardColumnFor(status, boardStatuses),
        archived: status === "archived",
        updatedAt: f.updatedAt,
      });
      return acc;
    }, [])
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeCards = cards.filter((card) => !card.archived);
  const archivedCards = cards.filter((card) => card.archived);
  // Archived count for the active view: tasks on the Board, notes on Notes.
  const archivedNoteCount = noteDocs(files).filter((d) => d.archived).length;
  // The header's Archived control is board/notes-specific — the Chats tab keeps
  // its archived group inside its own "View all" screen, so it reads 0 here
  // (disabling the button) on the Chats view.
  const archivedCount =
    workspaceView === "board"
      ? archivedCards.length
      : workspaceView === "notes"
        ? archivedNoteCount
        : 0;
  const unknownStatusIds = [...new Set(
    activeCards
      .map((card) => card.column)
      .filter((statusId) => !isKnownStatusId(statusId, boardStatuses)),
  )].sort((a, b) => a.localeCompare(b));
  const boardColumnIds = [
    ...boardStatuses.map((status) => status.id),
    ...unknownStatusIds,
  ];
  const byColumn = Object.fromEntries(
    boardColumnIds.map((statusId) => [
      statusId,
      activeCards.filter((card) => card.column === statusId),
    ]),
  ) as Record<string, Card[]>;
  boardFocusColumnsRef.current = boardColumnIds.map((statusId) => ({
    id: statusId,
    cardIds: byColumn[statusId].map((card) => card.id),
  }));

  function copyStatusId(statusId: string) {
    void navigator.clipboard.writeText(statusFrontmatterLine(statusId)).catch(() => {
      // Clipboard failures are non-fatal; the menu displays the bare id.
    });
  }

  async function commitStatusRename(status: ProjectStatus, nextName: string) {
    const trimmed = nextName.trim().replace(/\s+/g, " ");
    setRenamingStatusId(null);
    if (!trimmed || trimmed === status.name) return;

    const cardCount = byColumn[status.id]?.length ?? 0;
    try {
      if (cardCount === 0) {
        await updateStatuses({
          projectId,
          statuses: boardStatuses.map((item) =>
            item.id === status.id ? { ...item, name: trimmed } : item,
          ),
        });
        return;
      }

      setStatusMigrationRequest({
        kind: "rename",
        status,
        initialName: trimmed,
        cardCount,
        statuses: boardStatuses,
        onConfirm: async (name) => {
          await renameStatusWithMigration({
            projectId,
            statusId: status.id,
            name,
          });
        },
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function addUnknownStatus(statusId: string) {
    if (isKnownStatusId(statusId, boardStatuses)) return;
    try {
      await updateStatuses({
        projectId,
        statuses: [
          ...boardStatuses,
          { id: statusId, name: statusNameFromId(statusId) },
        ],
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

  function moveUnknownStatusCards(statusId: string) {
    const cardCount = byColumn[statusId]?.length ?? 0;
    if (cardCount === 0) return;
    setStatusMigrationRequest({
      kind: "move",
      status: { id: statusId, name: "Unknown" },
      cardCount,
      statuses: boardStatuses,
      onConfirm: async (destinationStatusId) => {
        await moveCardsWithStatus({
          projectId,
          statusId,
          destinationStatusId,
        });
      },
    });
  }

  async function deleteStatus(status: ProjectStatus) {
    if (boardStatuses.length <= 1) return;
    const cardCount = byColumn[status.id]?.length ?? 0;

    if (cardCount > 0) {
      setStatusMigrationRequest({
        kind: "delete",
        status,
        cardCount,
        statuses: boardStatuses,
        onConfirm: async (destinationStatusId) => {
          await deleteStatusWithMigration({
            projectId,
            statusId: status.id,
            destinationStatusId,
          });
        },
      });
      return;
    }

    const confirmed = window.confirm(`Delete "${status.name}"?`);
    if (!confirmed) return;

    try {
      await deleteStatusWithMigration({ projectId, statusId: status.id });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

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

  // Hand a note to an agent as an ordinary task: write a fresh task whose
  // frontmatter carries the machine link (`source-note`) back to the note and
  // whose body opens with a human-readable `Source note:` link (for the agent +
  // honesty). The agent's job is to edit the note file in place. Same upsert path
  // as createTask, then open the task dialog on it (pre-populated) — the
  // optimistic insert means the card is already in `cards` when we select it.
  async function createTaskFromNote(note: { title: string; path: string }) {
    const taken = new Set(cards.map((card) => card.slug));
    const title = `re: ${note.title}`;
    const slug = uniqueSlug(title, taken);
    const path = taskBodyPath(slug);
    const body = `Source note: [${note.title}](${note.path})\n\n`;
    const content = setFrontmatterKeys(body, {
      title,
      status: boardStatuses[0].id,
      "source-note": note.path,
    });
    const hash = await sha256(content);
    void upsertFile({ projectId, path, content, hash, deleted: false });
    setSelectedPath(path);
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
    setPendingCardId(card.id);
    try {
      await duplicateTaskWithAttachments({
        projectId,
        fromPrefix: `tasks/${card.slug}/attachments/`,
        taskPath: taskBodyPath(slug),
        taskContent: content,
        taskHash: await sha256(content),
      });
    } finally {
      setPendingCardId(null);
    }
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

  // Tombstone every (non-deleted) attachment row under a task's folder. The
  // daemon's listAttachments subscription then removes the local blobs and the
  // now-empty attachments/ + task folder. Server-side blob GC is out of scope.
  async function cascadeDeleteAttachments(slug: string) {
    const prefix = `tasks/${slug}/attachments/`;
    const rows = (attachments ?? []).filter(
      (row) => !row.deleted && row.path.startsWith(prefix),
    );
    await Promise.all(
      rows.map((row) =>
        tombstoneAttachment({ projectId, path: row.path }),
      ),
    );
  }

  async function deleteCard(card: Card) {
    setPendingCardId(card.id);
    try {
      await cascadeDeleteAttachments(card.slug);
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
      archivedCards.map(async (card) => {
        await cascadeDeleteAttachments(card.slug);
        await upsertFile({
          projectId,
          path: card.path,
          content: "",
          hash: "",
          deleted: true,
        });
      }),
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
      columnCards.map(async (card) => {
        await cascadeDeleteAttachments(card.slug);
        await upsertFile({
          projectId,
          path: card.path,
          content: "",
          hash: "",
          deleted: true,
        });
      }),
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

  // Command palette (⌘K) data + actions. Active-project scoped: its task/note
  // lists are the live cards/notes; the project list drives the switcher.
  const paletteProjects = projects.map(({ project }) => ({
    id: project._id,
    name: project.name,
  }));
  const paletteTasks = activeCards.map((card) => ({
    path: card.path,
    title: card.title,
    meta: boardStatuses.find((s) => s.id === card.column)?.name ?? card.column,
  }));
  const paletteNotes = noteDocs(files)
    .filter((doc) => !doc.archived)
    .map((doc) => ({ slug: doc.slug, title: doc.title, meta: doc.type }));
  const paletteAutomations = automationRecords.map((automation) => ({
    path: automation.automationPath,
    title: automation.name,
    meta: automation.enabled ? automation.scheduleDescription : "paused",
  }));
  const keepAwakeAvailable = keepAwake !== null && Boolean(keepAwakeBridge());
  const paletteActions: PaletteAction[] = [
    {
      id: "theme-dark",
      title: "Switch to Dark Mode",
      meta: "appearance",
      keywords: ["dark", "dark mode", "theme", "appearance", "settings"],
      icon: <MoonIcon className="size-4" />,
      onRun: () => setTheme("dark"),
    },
    {
      id: "theme-light",
      title: "Switch to Light Mode",
      meta: "appearance",
      keywords: ["light", "light mode", "theme", "appearance", "settings"],
      icon: <SunIcon className="size-4" />,
      onRun: () => setTheme("light"),
    },
    {
      id: "theme-system",
      title: "Use System Appearance",
      meta: "appearance",
      keywords: [
        "system",
        "system theme",
        "automatic",
        "theme",
        "appearance",
        "settings",
      ],
      icon: <MonitorIcon className="size-4" />,
      onRun: () => setTheme("system"),
    },
    {
      id: "theme-toggle",
      title: "Toggle Light/Dark Mode",
      meta: "appearance",
      keywords: [
        "toggle theme",
        "toggle dark mode",
        "toggle light mode",
        "theme",
        "appearance",
        "settings",
      ],
      icon: <SunMoonIcon className="size-4" />,
      onRun: () => setTheme(getStoredTheme() === "dark" ? "light" : "dark"),
    },
    {
      id: "settings-appearance",
      title: "Open Appearance Settings",
      meta: "settings",
      keywords: ["appearance", "theme", "settings", "preferences"],
      icon: <SettingsIcon className="size-4" />,
      onRun: () => openGlobalSettings("appearance"),
    },
    {
      id: "keep-awake-toggle",
      title: keepAwake?.enabled ? "Turn Keep Awake Off" : "Turn Keep Awake On",
      meta: keepAwakeAvailable
        ? keepAwake?.enabled
          ? "on"
          : "off"
        : "unavailable",
      keywords: [
        "keep awake",
        "toggle keep awake",
        "prevent sleep",
        "sleep",
        "power",
        "actions",
      ],
      disabled: !keepAwakeAvailable,
      icon: <PowerIcon className="size-4" />,
      onRun: () => void toggleKeepAwake(),
    },
    {
      id: "settings-harnesses",
      title: "Open Harness Settings",
      meta: "settings",
      keywords: [
        "harness",
        "harnesses",
        "agent",
        "agents",
        "codex",
        "claude",
        "settings",
      ],
      icon: <Code2Icon className="size-4" />,
      onRun: () => openGlobalSettings("harnesses"),
    },
  ];

  // Open a task: show the board first so the dialog floats over it (not Notes).
  function paletteOpenTask(path: string) {
    setWorkspaceView("board");
    setSelectedPath(path);
  }
  // New task → default column. With a title, create it directly; with none, open
  // the inline composer on the board so the user can name it.
  function paletteCreateTask(title: string) {
    setWorkspaceView("board");
    if (title) void createTask(boardStatuses[0].id, title);
    else setComposingCol(boardStatuses[0].id);
  }
  // Open / create a note: hand the request to NotesView (which owns the editor +
  // draft-flush lifecycle) after switching to the Notes view.
  function paletteOpenNote(slug: string) {
    setWorkspaceView("notes");
    setNoteIntent({ type: "open", slug });
  }
  function paletteCreateNote(title: string) {
    setWorkspaceView("notes");
    setNoteIntent({ type: "create", title });
  }
  function paletteOpenAutomation(path: string) {
    setWorkspaceView("automations");
    setAutomationIntent(path);
  }
  function paletteCreateAutomation(title: string) {
    setWorkspaceView("automations");
    void automationActions.createAutomation(title).then(setAutomationIntent);
  }

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
      onOpenPalette={() => setShowPalette(true)}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <header className="window-titlebar-row -mx-4 -mt-3 flex h-12 shrink-0 flex-nowrap items-center justify-between gap-3 overflow-hidden border-b border-border bg-background px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="flex shrink-0 items-center overflow-hidden rounded-lg border border-border">
            {WORKSPACE_VIEWS.map(({ view, title, Icon }, i) => (
              <button
                key={view}
                type="button"
                onClick={() => setWorkspaceView(view)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-medium transition-colors",
                  i > 0 && "border-l border-border",
                  workspaceView === view
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {title}
              </button>
            ))}
          </div>
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
              disabled={archivedCount === 0}
              onClick={() =>
                workspaceView === "board"
                  ? setShowArchived(true)
                  : setShowNotesArchived(true)
              }
            >
              <ArchiveIcon />
              Archived
              {archivedCount > 0 && (
                <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {archivedCount}
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

        {workspaceView === "notes" ? (
          <NotesView
            projectId={projectId}
            files={files}
            cards={cards}
            showArchived={showNotesArchived}
            onShowArchivedChange={setShowNotesArchived}
            onExit={() => setWorkspaceView("board")}
            onCreateTaskFromNote={(note) => void createTaskFromNote(note)}
            onOpenTask={(card) => setSelectedPath(card.path)}
            onArchiveTask={(card) => void setArchived(card, true)}
            onDeleteTask={(card) => void deleteCard(card)}
            intent={noteIntent}
            onIntentHandled={() => setNoteIntent(null)}
          />
        ) : workspaceView === "chats" ? (
          <ChatsView
            projectId={projectId}
            onManageHarnesses={() => openGlobalSettings("harnesses")}
            onExit={() => setWorkspaceView("notes")}
          />
        ) : workspaceView === "automations" ? (
          <AutomationsView
            projectId={projectId}
            files={files}
            intent={automationIntent}
            onIntentHandled={() => setAutomationIntent(null)}
            onExit={() => setWorkspaceView("board")}
          />
        ) : (
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
                isRenaming={renamingStatusId === col.id}
                onTitleClick={() => openProjectDetails("statuses")}
                onRename={() => setRenamingStatusId(col.id)}
                onRenameCommit={(name) => void commitStatusRename(col, name)}
                onCopyStatusId={() => copyStatusId(col.id)}
                onManageStatuses={() => openProjectDetails("statuses")}
                onDeleteStatus={() => void deleteStatus(col)}
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
                    registerCardNode={registerBoardCardNode}
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
            {unknownStatusIds.map((statusId) => (
              <UnknownStatusColumn
                key={statusId}
                statusId={statusId}
                count={byColumn[statusId].length}
                onAddAsStatus={() => void addUnknownStatus(statusId)}
                onMoveCards={() => moveUnknownStatusCards(statusId)}
              >
                {byColumn[statusId].map((card) => (
                  <DraggableCard
                    key={card.id}
                    card={card}
                    projectId={projectId}
                    pending={pendingCardId === card.id}
                    registerCardNode={registerBoardCardNode}
                    onOpen={(card) => setSelectedPath(card.path)}
                    onArchiveToggle={(c, archived) =>
                      void setArchived(c, archived)
                    }
                    onDuplicate={(c) => void duplicateTask(c)}
                    onDelete={(c) => void deleteCard(c)}
                  />
                ))}
              </UnknownStatusColumn>
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
        )}

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

        <StatusMigrationDialog
          request={statusMigrationRequest}
          onClose={() => setStatusMigrationRequest(null)}
        />

        <CommandPalette
          open={showPalette}
          onOpenChange={setShowPalette}
          projects={paletteProjects}
          activeProjectId={projectId}
          activeProjectName={currentProject.name}
          currentView={workspaceView}
          tasks={paletteTasks}
          notes={paletteNotes}
          automations={paletteAutomations}
          actions={paletteActions}
          onSelectProject={onSelectProject}
          onSelectView={setWorkspaceView}
          onOpenTask={paletteOpenTask}
          onCreateTask={paletteCreateTask}
          onOpenNote={paletteOpenNote}
          onCreateNote={paletteCreateNote}
          onOpenAutomation={paletteOpenAutomation}
          onCreateAutomation={paletteCreateAutomation}
          onCreateProject={(name) => setCreateProjectName(name)}
        />

        {/* Palette-driven "New project" reuses the sidebar dialog, pre-filled
            with the typed query. */}
        <CreateProjectDialog
          open={createProjectName !== null}
          onOpenChange={(open) => {
            if (!open) setCreateProjectName(null);
          }}
          creating={creatingProject}
          onCreate={onCreateProject}
          initialName={createProjectName ?? ""}
        />
      </div>
    </AppShell>
  );
}

export default function Board() {
  return (
    <>
      <AuthenticatedBoard />
      <ProjectConflictDialog />
    </>
  );
}
