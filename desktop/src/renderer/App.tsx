"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
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
  ArchiveIcon,
  ArchiveRestoreIcon,
  ExternalLinkIcon,
  FolderSyncIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { parseFrontmatter, setFrontmatterKeys } from "@/lib/frontmatter";
import {
  parseChatRef,
  parseChatStatus,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { sha256 } from "@/lib/hash";
import { taskBodyPath, taskSlug, uniqueSlug } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { TaskDialog, type TaskTarget } from "@/components/TaskDialog";
import { ChatLaunch } from "@/components/ChatLaunch";
import { DeviceTokens } from "@/components/DeviceTokens";
import { LocalSyncDialog } from "@/components/LocalSyncDialog";
import { ProjectDetailsDialog } from "@/components/ProjectDetailsDialog";
import { HITCH_PROJECT } from "@/lib/config";
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

// Columns the board shows, in order. Any task whose `status` frontmatter
// doesn't match one of these falls into "todo". Legacy `blocked` cards land in
// review so old files don't disappear from the expected workflow.
const COLUMNS = ["todo", "in-progress", "review", "done"] as const;
type Column = (typeof COLUMNS)[number];

function columnFor(status: string | undefined): Column {
  const s = (status ?? "").toLowerCase();
  if (s === "blocked") return "review";
  return (COLUMNS as readonly string[]).includes(s) ? (s as Column) : "todo";
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
  column: Column;
  archived: boolean;
  updatedAt: number;
}

interface ProjectNavEntry {
  project: {
    _id: string;
    name: string;
    slug: string;
  };
  membership: {
    role: "owner" | "member";
  } | null;
}

interface HitchBinding {
  project: string;
  projectName?: string;
  localPath: string;
  enabled: boolean;
}

interface LocalHitchConfig {
  activeProject: string;
  hitches: HitchBinding[];
}

interface DeviceAuthState {
  deviceId: string;
  deviceName: string;
  hostname: string;
  hasToken: boolean;
}

// Shared card chrome, also reused by the drag overlay so the floating element
// matches the one in the column.
const CARD_CLASS =
  "rounded-lg bg-card p-3 text-left shadow-sm ring-1 ring-border";

function CardSummary({ card }: { card: Card }) {
  return (
    <p className="text-sm font-medium text-card-foreground">{card.title}</p>
  );
}

function CardChat({ card, project }: { card: Card; project: string }) {
  if (!card.chat) return null;

  return (
    <div className="mt-2">
      <ChatLaunch
        chat={card.chat}
        status={card.chatStatus}
        project={project}
        size="xs"
        stopPropagation
      />
    </div>
  );
}

function CardContents({ card, project }: { card: Card; project: string }) {
  return (
    <>
      <CardSummary card={card} />
      {card.chat && (
        <CardChat card={card} project={project} />
      )}
    </>
  );
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
    <main className="flex min-h-screen items-center justify-center p-8">
      <section className="flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Hitch</h1>
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

function AppSidebar({
  projects,
  selectedProject,
  localHitches,
  deviceAuth,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onShowProjectDetails,
  onShowDeviceTokens,
  onShowLocalSync,
  onSignOut,
}: {
  projects: ProjectNavEntry[];
  selectedProject: string;
  localHitches: HitchBinding[];
  deviceAuth: DeviceAuthState | null;
  creatingProject: boolean;
  onSelectProject: (project: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onShowProjectDetails: () => void;
  onShowDeviceTokens: () => void;
  onShowLocalSync: () => void;
  onSignOut: () => void;
}) {
  const [showCreateProject, setShowCreateProject] = useState(false);

  return (
    <aside className="flex shrink-0 items-center gap-3 border-b bg-sidebar px-3 py-2 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-64 md:flex-col md:items-stretch md:border-b-0 md:border-r md:border-sidebar-border md:px-3 md:py-4">
      <nav className="hidden flex-1 flex-col gap-1 overflow-auto md:flex">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-xs font-medium uppercase tracking-wide text-sidebar-foreground/50">
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
        ) : (
          projects.map(({ project }) => {
            const hitch = localHitches.find((entry) => entry.project === project.slug);
            const selected = project.slug === selectedProject;
            return (
              <div
                key={project._id}
                className={cn(
                  "group flex min-h-9 items-center rounded-lg pr-1 transition-colors",
                  selected
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectProject(project.slug)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2 text-left text-sm"
                >
                  <LayoutDashboardIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </button>
                {/* Fixed trailing slot: the hitch status dot, swapped for the
                    project-details gear on hover so neither crowds the name. */}
                <div className="flex w-6 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "size-2 rounded-full group-hover:hidden",
                      hitch?.enabled ? "bg-emerald-500" : "bg-sidebar-border",
                    )}
                    title={hitch?.enabled ? "Hitched locally" : "Not hitched locally"}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => {
                            onSelectProject(project.slug);
                            onShowProjectDetails();
                          }}
                          aria-label="Project details"
                          className="hidden text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover:inline-flex"
                        />
                      }
                    >
                      <SettingsIcon />
                    </TooltipTrigger>
                    <TooltipContent>Project details</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </nav>

      <CreateProjectDialog
        open={showCreateProject}
        onOpenChange={setShowCreateProject}
        creating={creatingProject}
        onCreate={onCreateProject}
      />

      <div className="ml-auto flex items-center gap-1 md:ml-0 md:mt-auto md:flex-col md:items-stretch md:border-t md:border-sidebar-border md:pt-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onShowDeviceTokens}
          aria-label="Device tokens"
          className="justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:w-full"
        >
          <KeyRoundIcon />
          <span className="hidden md:inline">Device tokens</span>
        </Button>
        <div className="hidden px-2 text-xs text-sidebar-foreground/55 md:block">
          This Mac: {deviceAuth?.hasToken ? "authorized" : "not authorized"}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onShowLocalSync}
          aria-label="Local sync"
          className="justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:w-full"
        >
          <FolderSyncIcon />
          <span className="hidden md:inline">Local sync</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          aria-label="Sign out"
          className="justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:w-full"
        >
          <LogOutIcon />
          <span className="hidden md:inline">Sign out</span>
        </Button>
      </div>
    </aside>
  );
}

function AppShell({
  projects,
  selectedProject,
  localHitches,
  deviceAuth,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onShowProjectDetails,
  onShowDeviceTokens,
  onShowLocalSync,
  onSignOut,
  children,
}: {
  projects: ProjectNavEntry[];
  selectedProject: string;
  localHitches: HitchBinding[];
  deviceAuth: DeviceAuthState | null;
  creatingProject: boolean;
  onSelectProject: (project: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onShowProjectDetails: () => void;
  onShowDeviceTokens: () => void;
  onShowLocalSync: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <AppSidebar
        projects={projects}
        selectedProject={selectedProject}
        localHitches={localHitches}
        deviceAuth={deviceAuth}
        creatingProject={creatingProject}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onShowProjectDetails={onShowProjectDetails}
        onShowDeviceTokens={onShowDeviceTokens}
        onShowLocalSync={onShowLocalSync}
        onSignOut={onSignOut}
      />
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}

function AuthenticatedBoard() {
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (isLoading) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Checking session…
      </main>
    );
  }

  if (!isAuthenticated) return <SignInScreen />;

  return <ProjectWorkspace />;
}

function ProjectWorkspace() {
  const bridge = typeof window !== "undefined" ? window.hitchDaemon : undefined;
  const projects = useQuery(api.projects.listMine) ?? [];
  const createProjectMutation = useMutation(api.projects.create);
  const authorizeDevice = useMutation(api.deviceTokens.authorizeDevice);
  const [selectedProject, setSelectedProject] = useState(HITCH_PROJECT);
  const [localConfig, setLocalConfig] = useState<LocalHitchConfig>({
    activeProject: HITCH_PROJECT,
    hitches: [],
  });
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthState | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getConfig().then((config) => {
      setLocalConfig(config);
      if (config.activeProject) setSelectedProject(config.activeProject);
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

  const currentProject =
    selectedProject || projects[0]?.project.slug || HITCH_PROJECT;

  async function selectProject(project: string) {
    setSelectedProject(project);
    if (!bridge) return;
    setLocalConfig(await bridge.setActiveProject(project));
  }

  async function createProject(name: string) {
    setCreatingProject(true);
    try {
      const project = await createProjectMutation({ name });
      if (project) await selectProject(project.slug);
    } finally {
      setCreatingProject(false);
    }
  }

  return (
    <BoardContent
      project={currentProject}
      projects={projects}
      localHitches={localConfig.hitches}
      deviceAuth={deviceAuth}
      creatingProject={creatingProject}
      onSelectProject={(project) => void selectProject(project)}
      onCreateProject={createProject}
      onLocalConfigChange={setLocalConfig}
    />
  );
}

// The hover-revealed archive shortcut in a card's top-right corner. Clicking it
// once arms a confirmation (the icon becomes an "Archive" pill); clicking the
// pill archives. `onPointerDown`/`onClick` stop propagation so the button drives
// neither the card's drag (PointerSensor listeners live on the summary) nor its
// open-on-click. Only rendered for unarchived cards — restoring stays in the
// context menu.
function stopCardPropagation(e: React.PointerEvent | React.MouseEvent) {
  e.stopPropagation();
}

function ArchiveShortcut({
  confirming,
  pending,
  onArm,
  onConfirm,
}: {
  confirming: boolean;
  pending: boolean;
  onArm: () => void;
  onConfirm: () => void;
}) {
  if (confirming) {
    return (
      <button
        type="button"
        disabled={pending}
        aria-label="Confirm archive"
        onPointerDown={stopCardPropagation}
        onClick={(e) => {
          stopCardPropagation(e);
          onConfirm();
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground shadow-sm ring-1 ring-border hover:bg-foreground hover:text-background"
      >
        <ArchiveIcon className="size-3" />
        Confirm
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={pending}
            aria-label="Archive"
            onPointerDown={stopCardPropagation}
            onClick={(e) => {
              stopCardPropagation(e);
              onArm();
            }}
            className="absolute right-2 top-2 hidden rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground group-hover:block focus-visible:block focus-visible:outline-none"
          />
        }
      >
        <ArchiveIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>Archive</TooltipContent>
    </Tooltip>
  );
}

interface DraggableCardProps {
  card: Card;
  project: string;
  pending: boolean;
  onOpen: (card: Card) => void;
  onArchiveToggle: (card: Card, archived: boolean) => void;
  onDelete: (card: Card) => void;
}

// A board card that can be picked up (left-drag, 5px threshold so a plain click
// still opens it) and dropped on another column. Right-click keeps the existing
// archive/delete menu — PointerSensor ignores non-primary buttons, so the menu
// and dragging don't fight. Defined at module scope (not inside Board) so it
// isn't a fresh component type each render, which would remount mid-drag.
function DraggableCard({
  card,
  project,
  pending,
  onOpen,
  onArchiveToggle,
  onDelete,
}: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
  });
  // Whether the hover archive shortcut has been clicked once and is now showing
  // its "Archive" confirmation pill. Reset when the pointer leaves the card so a
  // half-armed card doesn't stay armed.
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          ref={setNodeRef}
          onMouseLeave={() => setConfirmingArchive(false)}
          className={cn(
            CARD_CLASS,
            "group relative cursor-pointer transition-shadow hover:ring-foreground/20",
            isDragging && "opacity-40",
          )}
        >
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => onOpen(card)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpen(card);
            }}
            className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CardSummary card={card} />
          </button>
          <CardChat card={card} project={project} />
          {!card.archived && (
            <ArchiveShortcut
              confirming={confirmingArchive}
              pending={pending}
              onArm={() => setConfirmingArchive(true)}
              onConfirm={() => {
                setConfirmingArchive(false);
                onArchiveToggle(card, true);
              }}
            />
          )}
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
        className="w-full bg-transparent text-sm font-medium text-card-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />
    </div>
  );
}

// A column that accepts dropped cards. Its droppable id IS the status value, so
// the drop handler can read the destination status straight off `over.id`.
function DroppableColumn({
  col,
  count,
  onAdd,
  children,
}: {
  col: Column;
  count: number;
  onAdd: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "relative flex flex-col gap-3 rounded-xl bg-muted p-3 transition-colors",
        isOver && "ring-2 ring-ring",
      )}
    >
      <div className="relative z-20 flex items-center justify-between px-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {col} · {count}
        </h2>
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
      </div>
      {children}
      {count === 0 && <p className="px-1 text-xs text-muted-foreground/70">No tasks</p>}

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
  project,
  projects,
  localHitches,
  deviceAuth,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onLocalConfigChange,
}: {
  project: string;
  projects: ProjectNavEntry[];
  localHitches: HitchBinding[];
  deviceAuth: DeviceAuthState | null;
  creatingProject: boolean;
  onSelectProject: (project: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onLocalConfigChange: (config: LocalHitchConfig) => void;
}) {
  const { signOut } = useAuthActions();
  const projectAccess = useQuery(api.projects.current, { project });
  const claimProject = useMutation(api.projects.claimLegacyProject);
  const projectReady = projectAccess?.project !== null && projectAccess !== undefined;
  const files = useQuery(
    api.files.listFiles,
    projectReady ? { project } : "skip",
  );
  // Optimistically patch the cached file so a drag/archive/delete — and a brand
  // new task — reflects instantly instead of waiting on the frontmatter →
  // daemon → Convex round trip. Bumping updatedAt lands the card at the top of
  // its (destination) column, matching how the server-stamped value will sort
  // once it settles. A create hits the same path: no row matches the key, so we
  // append a fabricated one (real _id arrives when the daemon round-trips).
  const upsertFile = useMutation(api.files.upsertFile).withOptimisticUpdate(
    (localStore, args) => {
      const existing = localStore.getQuery(api.files.listFiles, {
        project: args.project,
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
        { project: args.project },
        next,
      );
    },
  );
  const [selected, setSelected] = useState<Card | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showDeviceTokens, setShowDeviceTokens] = useState(false);
  const [showLocalSync, setShowLocalSync] = useState(false);
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which column, if any, has its inline "new task" composer open.
  const [composingCol, setComposingCol] = useState<Column | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    if (projectAccess?.legacy !== true) return;
    void claimProject({ project, name: project });
  }, [claimProject, project, projectAccess?.legacy]);

  // `C` arms the composer on the first column for keyboard-driven creation.
  // Ignored while typing in a field or with the editor open, and when chorded
  // with a modifier (so browser shortcuts like ⌘C still work).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (selected) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      ) {
        return;
      }
      e.preventDefault();
      setComposingCol(COLUMNS[0]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!projectReady || files === undefined) {
    return (
      <AppShell
        projects={projects}
        selectedProject={project}
        localHitches={localHitches}
        deviceAuth={deviceAuth}
        creatingProject={creatingProject}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onShowProjectDetails={() => setShowProjectDetails(true)}
        onShowDeviceTokens={() => setShowDeviceTokens(true)}
        onShowLocalSync={() => setShowLocalSync(true)}
        onSignOut={() => void signOut()}
      >
        <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
          {projectAccess?.legacy === true
            ? "Creating project..."
            : "Connecting to Convex..."}
        </div>
        <DeviceTokens
          project={project}
          open={showDeviceTokens}
          onOpenChange={setShowDeviceTokens}
        />
        <LocalSyncDialog
          project={project}
          open={showLocalSync}
          onOpenChange={setShowLocalSync}
          onConfigChange={onLocalConfigChange}
        />
        <ProjectDetailsDialog
          project={project}
          open={showProjectDetails}
          onOpenChange={setShowProjectDetails}
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
        column: columnFor(status),
        archived: status === "archived",
        updatedAt: f.updatedAt,
      });
      return acc;
    }, [])
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const activeCards = cards.filter((card) => !card.archived);
  const archivedCards = cards.filter((card) => card.archived);
  const byColumn = Object.fromEntries(
    COLUMNS.map((c) => [c, activeCards.filter((card) => card.column === c)]),
  ) as Record<Column, Card[]>;

  const target: TaskTarget | null = selected && {
    project,
    path: selected.path,
    title: selected.title,
    content: selected.content,
  };

  // Create a task by writing a fresh `tasks/<slug>/task.md` through the same
  // upsert path everything else uses; the daemon writes the file and the live
  // query renders the card (instantly, via the optimistic insert above).
  async function createTask(column: Column, title: string) {
    const taken = new Set(cards.map((card) => card.slug));
    const slug = uniqueSlug(title, taken);
    const content = setFrontmatterKeys("", { title, status: column });
    await upsertFile({
      project: project,
      path: taskBodyPath(slug),
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  async function setArchived(card: Card, archived: boolean) {
    const { frontmatter } = parseFrontmatter(card.content);
    const restoreStatus = columnFor(frontmatter.archivedFrom);
    const nextContent = setFrontmatterKeys(card.content, {
      status: archived ? "archived" : restoreStatus,
      archivedFrom: archived ? card.column : undefined,
      "chat-status": archived ? undefined : card.chatStatus ?? undefined,
    });

    setPendingCardId(card.id);
    try {
      await upsertFile({
        project: project,
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
        project: project,
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
          project: project,
          path: card.path,
          content: "",
          hash: "",
          deleted: true,
        }),
      ),
    );
  }

  // Move a card to another column by rewriting just its `status` frontmatter,
  // through the same save path the dialog and archive use.
  async function setStatus(card: Card, status: Column) {
    const nextContent = setFrontmatterKeys(card.content, {
      status,
      "chat-status": status === "done" ? undefined : card.chatStatus ?? undefined,
    });

    setPendingCardId(card.id);
    try {
      await upsertFile({
        project: project,
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
    const dest = over.id as Column;
    if (!card || (card.column === dest && !card.archived)) return;
    void setStatus(card, dest);
  }

  const activeCard = activeId
    ? (cards.find((c) => c.id === activeId) ?? null)
    : null;

  return (
    <AppShell
      projects={projects}
      selectedProject={project}
      localHitches={localHitches}
      deviceAuth={deviceAuth}
      creatingProject={creatingProject}
      onSelectProject={onSelectProject}
      onCreateProject={onCreateProject}
      onShowProjectDetails={() => setShowProjectDetails(true)}
      onShowDeviceTokens={() => setShowDeviceTokens(true)}
      onShowLocalSync={() => setShowLocalSync(true)}
      onSignOut={() => void signOut()}
    >
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
            <span className="text-sm text-muted-foreground">
              {activeCards.length} task
              {activeCards.length === 1 ? "" : "s"} · live
            </span>
          </div>
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
        </header>

        <DndContext
          sensors={sensors}
          onDragStart={(event: DragStartEvent) =>
            setActiveId(String(event.active.id))
          }
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {COLUMNS.map((col) => (
              <DroppableColumn
                key={col}
                col={col}
                count={byColumn[col].length}
                onAdd={() => setComposingCol(col)}
              >
                {composingCol === col && (
                  <TaskComposer
                    onCreate={(title) => void createTask(col, title)}
                    onClose={() => setComposingCol(null)}
                  />
                )}
                {byColumn[col].map((card) => (
                  <DraggableCard
                    key={card.id}
                    card={card}
                    project={project}
                    pending={pendingCardId === card.id}
                    onOpen={setSelected}
                    onArchiveToggle={(c, archived) =>
                      void setArchived(c, archived)
                    }
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
                <CardContents card={activeCard} project={project} />
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

        <DeviceTokens
          project={project}
          open={showDeviceTokens}
          onOpenChange={setShowDeviceTokens}
        />

        <LocalSyncDialog
          project={project}
          open={showLocalSync}
          onOpenChange={setShowLocalSync}
          onConfigChange={onLocalConfigChange}
        />

        <ProjectDetailsDialog
          project={project}
          open={showProjectDetails}
          onOpenChange={setShowProjectDetails}
        />

        <TaskDialog
          task={target}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        />
      </div>
    </AppShell>
  );
}

export default function Board() {
  return <AuthenticatedBoard />;
}
