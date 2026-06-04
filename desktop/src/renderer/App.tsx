"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
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
  AlertCircleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  Code2Icon,
  CopyIcon,
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
  clearChatFields,
  parseChatOpenState,
  parseChatRef,
  parseChatStatus,
  type ChatOpenState,
  type ChatRef,
  type ChatStatus,
} from "@/lib/chat";
import { sha256 } from "@/lib/hash";
import { taskBodyPath, taskSlug, uniqueSlug } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { TaskDialog, type TaskTarget } from "@/components/TaskDialog";
import { ChatLaunch } from "@/components/ChatLaunch";
import { DeviceTokens } from "@/components/DeviceTokens";
import { GlobalSettingsDialog } from "@/components/GlobalSettingsDialog";
import { LocalSyncDialog } from "@/components/LocalSyncDialog";
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

interface ProjectStatus {
  id: string;
  name: string;
}

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

// Shared card chrome, also reused by the drag overlay so the floating element
// matches the one in the column.
const CARD_CLASS =
  "rounded-lg bg-card p-3 text-left shadow-sm ring-1 ring-border";

function CardSummary({ card }: { card: Card }) {
  return (
    <p className="text-sm font-medium text-card-foreground">{card.title}</p>
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
    <div className="mt-2">
      <ChatLaunch
        chat={card.chat}
        status={card.chatStatus}
        openState={card.chatOpenState}
        projectId={projectId}
        size="xs"
        stopPropagation
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
  selectedProjectId,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onShowProjectDetails,
  onShowLocalSync,
  onShowGlobalSettings,
  onShowDeviceTokens,
  onSignOut,
}: {
  projects: ProjectNavEntry[];
  selectedProjectId: Id<"projects">;
  creatingProject: boolean;
  onSelectProject: (projectId: Id<"projects">) => void;
  onCreateProject: (name: string) => Promise<void>;
  onShowProjectDetails: () => void;
  onShowLocalSync: () => void;
  onShowGlobalSettings: () => void;
  onShowDeviceTokens: () => void;
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
            const selected = project._id === selectedProjectId;
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
                  onClick={() => onSelectProject(project._id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2 text-left text-sm"
                >
                  <LayoutDashboardIcon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                </button>
                {/* Fixed trailing slot: the project-details gear, revealed on
                    hover so it doesn't crowd the project name. */}
                <div className="flex w-6 shrink-0 items-center justify-center">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => {
                            onSelectProject(project._id);
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
        <UpdateBanner />
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
          onClick={onShowGlobalSettings}
          aria-label="Harness settings"
          className="justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:w-full"
        >
          <Code2Icon />
          <span className="hidden md:inline">Harnesses</span>
        </Button>
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
  selectedProjectId,
  creatingProject,
  onSelectProject,
  onCreateProject,
  onShowProjectDetails,
  onShowLocalSync,
  onShowGlobalSettings,
  onShowDeviceTokens,
  onSignOut,
  children,
}: {
  projects: ProjectNavEntry[];
  selectedProjectId: Id<"projects">;
  creatingProject: boolean;
  onSelectProject: (projectId: Id<"projects">) => void;
  onCreateProject: (name: string) => Promise<void>;
  onShowProjectDetails: () => void;
  onShowLocalSync: () => void;
  onShowGlobalSettings: () => void;
  onShowDeviceTokens: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <AppSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        creatingProject={creatingProject}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onShowProjectDetails={onShowProjectDetails}
        onShowLocalSync={onShowLocalSync}
        onShowGlobalSettings={onShowGlobalSettings}
        onShowDeviceTokens={onShowDeviceTokens}
        onSignOut={onSignOut}
      />
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
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
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-md flex-col gap-5 rounded-lg border bg-card p-6 shadow-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Welcome to Hitch
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Create your first project
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Projects are now driven by your Hitch account. Create one, then bind
            it to a local folder when you are ready to sync task files.
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
      <main className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading projects…
      </main>
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
      <main className="flex min-h-screen items-center justify-center text-muted-foreground">
        Opening project…
      </main>
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
  projectId: Id<"projects">;
  pending: boolean;
  onOpen: (card: Card) => void;
  onArchiveToggle: (card: Card, archived: boolean) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

// A board card that can be picked up (left-drag, 5px threshold so a plain click
// still opens it) and dropped on another column. Right-click keeps the existing
// archive/delete menu — PointerSensor ignores non-primary buttons, so the menu
// and dragging don't fight. Defined at module scope (not inside Board) so it
// isn't a fresh component type each render, which would remount mid-drag.
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
          <CardChat card={card} projectId={projectId} />
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
        className="w-full bg-transparent text-sm font-medium text-card-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground"
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
  children,
}: {
  status: ProjectStatus;
  count: number;
  onAdd: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "relative flex min-h-[24rem] w-[17rem] shrink-0 flex-col gap-3 rounded-xl bg-muted p-3 transition-colors",
        isOver && "ring-2 ring-ring",
      )}
    >
      <div className="relative z-20 flex items-center justify-between px-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {status.name} · {count}
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
      {count === 0 && (
        <p className="px-1 text-xs text-muted-foreground/70">No tasks</p>
      )}

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
  const [showDeviceTokens, setShowDeviceTokens] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [showLocalSync, setShowLocalSync] = useState(false);
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [projectDetailsTab, setProjectDetailsTab] =
    useState<ProjectDetailsTab>("general");
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which column, if any, has its inline "new task" composer open.
  const [composingCol, setComposingCol] = useState<string | null>(null);
  const boardStatuses = useMemo(
    () => statusesForProject(currentProject?.statuses),
    [currentProject?.statuses],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
        onShowProjectDetails={() => openProjectDetails()}
        onShowLocalSync={() => setShowLocalSync(true)}
        onShowGlobalSettings={() => setShowGlobalSettings(true)}
        onShowDeviceTokens={() => setShowDeviceTokens(true)}
        onSignOut={() => void signOut()}
      >
        <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
          Connecting to Convex...
        </div>
        <DeviceTokens
          open={showDeviceTokens}
          onOpenChange={setShowDeviceTokens}
        />
        <GlobalSettingsDialog
          open={showGlobalSettings}
          onOpenChange={setShowGlobalSettings}
        />
        <LocalSyncDialog
          open={showLocalSync}
          onOpenChange={setShowLocalSync}
          onConfigChange={onLocalConfigChange}
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
      onShowProjectDetails={() => openProjectDetails()}
      onShowLocalSync={() => setShowLocalSync(true)}
      onShowGlobalSettings={() => setShowGlobalSettings(true)}
      onShowDeviceTokens={() => setShowDeviceTokens(true)}
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
          <div className="flex items-center gap-2">
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
                <p className="font-medium">This project is not hitched locally.</p>
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
          <div className="-mx-4 flex flex-1 gap-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            {boardStatuses.map((col) => (
              <DroppableColumn
                key={col.id}
                status={col}
                count={byColumn[col.id].length}
                onAdd={() => setComposingCol(col.id)}
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

        <DeviceTokens
          open={showDeviceTokens}
          onOpenChange={setShowDeviceTokens}
        />
        <GlobalSettingsDialog
          open={showGlobalSettings}
          onOpenChange={setShowGlobalSettings}
        />

        <LocalSyncDialog
          open={showLocalSync}
          onOpenChange={setShowLocalSync}
          onConfigChange={onLocalConfigChange}
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
        />
      </div>
    </AppShell>
  );
}

export default function Board() {
  return <AuthenticatedBoard />;
}
