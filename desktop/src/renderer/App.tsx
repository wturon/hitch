"use client";

import {
  useCallback,
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
  AlertCircleIcon,
  Code2Icon,
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
} from "lucide-react";
import { parseFrontmatter, setFrontmatterKeys } from "@/lib/frontmatter";
import { sha256 } from "@/lib/hash";
import { parseProjectConfig, PROJECT_CONFIG_PATH } from "@/lib/projectConfig";
import { taskBodyPath, taskSlug } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { parseChatRef } from "@/lib/chat";
import {
  NotesView,
  noteDocs,
  type NoteDoc,
  type NoteIntent,
} from "@/components/NotesView";
import { DebugView } from "@/components/DebugView";
import { SandboxEditor } from "@/editor";
import { AutomationsView } from "@/components/AutomationsView";
import { TodosView } from "@/components/TodosView";
import { TodoDialog } from "@/components/todo-dialog/TodoDialog";
import {
  closedState,
  commitState,
  createState,
  editState,
  reconcileState,
  type TodoDialogState,
} from "@/components/todo-dialog/dialogState";
import { deriveTodoGroups, prependBacklogPath, type Todo } from "@/lib/todos";
import {
  CommandPalette,
  WORKSPACE_VIEWS,
  type PaletteAction,
  type WorkspaceView,
} from "@/components/CommandPalette";
import {
  GlobalSettingsDialog,
  type GlobalHarnessSetupStatus,
  type IntegrationHealth,
  type GlobalSettingsTab,
} from "@/components/GlobalSettingsDialog";
import {
  ProjectDetailsDialog,
  type DetailsTab as ProjectDetailsTab,
  type ProjectArchive,
} from "@/components/ProjectDetailsDialog";
import { AppSidebar, CreateProjectDialog } from "@/components/AppSidebar";
import { ProjectConflictDialog } from "@/components/ProjectConflictDialog";
import type { KeepAwakeState, ProjectNavEntry } from "@/lib/types";
import { UpdateBanner } from "@/components/UpdateBanner";
import { getStoredTheme, setTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SpellcheckMenu } from "@/components/SpellcheckMenu";
import { showUndoableToast, useUndoHotkey } from "@/lib/undoToast";
import { HarnessIcon } from "@/components/HarnessIcon";

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
  checkIntegrations: () => Promise<IntegrationHealth>;
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
              Use GitHub to open your live workspace.
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
  integrationHealth,
  keepAwake,
  onToggleKeepAwake,
  onShowGlobalSettings,
  onShowDebug,
  onShowEditorSandbox,
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
  integrationHealth: IntegrationHealth | null;
  keepAwake: KeepAwakeState | null;
  onToggleKeepAwake: () => void;
  onShowGlobalSettings: (tab?: GlobalSettingsTab) => void;
  onShowDebug?: () => void;
  onShowEditorSandbox?: () => void;
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

  // ⌘\ (Ctrl+\ on Windows/Linux) toggles the rail. Unlike the `C` capture
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
        integrationHealth={integrationHealth}
        keepAwake={keepAwake}
        onToggleKeepAwake={onToggleKeepAwake}
        onShowGlobalSettings={onShowGlobalSettings}
        onShowDebug={onShowDebug}
        onShowEditorSandbox={onShowEditorSandbox}
        onSignOut={onSignOut}
        onOpenPalette={onOpenPalette}
      />
      {/* The layout wrapper adds no padding — each page owns its own gutters so
          content (e.g. the Todos list) can run flush up to the header's grey
          rule instead of being inset by a shared frame. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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

function AuthenticatedWorkspace() {
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
    <WorkspaceContent
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

// An archived todo, the minimal shape the settings dialog's Archive tab
// renders and acts on. `content` is the raw task.md so Unarchive can clear its
// `archived-at:`.
interface ArchivedTodo {
  path: string; // tasks/<slug>/task.md
  slug: string;
  title: string;
  content: string;
}

type TaskToastContext = {
  title: string;
  chat: ReturnType<typeof parseChatRef>;
};

function taskToastContext(content: string, fallbackTitle: string): TaskToastContext {
  const { frontmatter } = parseFrontmatter(content);
  return {
    title: frontmatter.title?.trim() || fallbackTitle,
    chat: parseChatRef(frontmatter),
  };
}

function taskToastPayload(
  context: TaskToastContext,
  detail?: string,
): {
  description: ReactNode;
  icon?: ReactNode;
} {
  return {
    description: (
      <span className="flex flex-col gap-1">
        <span className="font-medium text-foreground">{context.title}</span>
        {detail ? <span>{detail}</span> : null}
      </span>
    ),
    icon: context.chat ? (
      <HarnessIcon harness={context.chat.harness} className="size-4" />
    ) : undefined,
  };
}

function WorkspaceContent({
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
  // Optimistically patch the cached file so a checkbox/archive/delete — and a
  // brand new todo — reflects instantly instead of waiting on the frontmatter →
  // daemon → Convex round trip. Bumping updatedAt lands the row at the top of
  // its group, matching how the server-stamped value will sort once it settles.
  // A create hits the same path: no row matches the key, so we append a
  // fabricated one (real _id arrives when the daemon round-trips).
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
  // Close-on-done: checking a todo done enqueues a close-chat command so the
  // daemon can kill the chat's cmux tab (stray tabs eat memory). Fire-and-forget
  // — a close that can't run just leaves the tab open, never blocks the check.
  const enqueueCommand = useMutation(api.commands.enqueueCommand);
  // Attachment rows for the project (image blobs live outside `files`). We only
  // need them to drive the delete cascade: when a task is removed, tombstone its
  // attachment rows so the daemon cleans up the local files + empty folders.
  const attachments = useQuery(api.attachments.listAttachments, { projectId });
  const tombstoneAttachment = useMutation(api.attachments.tombstoneAttachment);
  const registerAttachment = useMutation(api.attachments.registerAttachment);
  // Backlog manual order — read for the uncheck→backlog-top prepend (slice 5,
  // Decision 8). Whole-list-replace with an optimistic patch so the row lands at
  // the top instantly (same pattern TodosView uses for drag reorders).
  const backlogOrder =
    useQuery(api.backlogOrders.getBacklogOrder, { projectId }) ?? [];
  const backlogOrderRef = useRef<string[]>(backlogOrder);
  backlogOrderRef.current = backlogOrder;
  const setBacklogOrder = useMutation(
    api.backlogOrders.setBacklogOrder,
  ).withOptimisticUpdate((store, args) => {
    store.setQuery(
      api.backlogOrders.getBacklogOrder,
      { projectId: args.projectId },
      args.order,
    );
  });
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalSettingsTab, setGlobalSettingsTab] =
    useState<GlobalSettingsTab>("harnesses");
  const [globalHarnessSetup, setGlobalHarnessSetup] =
    useState<GlobalHarnessSetupStatus | null>(null);
  const [integrationHealth, setIntegrationHealth] =
    useState<IntegrationHealth | null>(null);
  const [keepAwake, setKeepAwake] = useState<KeepAwakeState | null>(null);
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [projectDetailsTab, setProjectDetailsTab] =
    useState<ProjectDetailsTab>("general");
  // The Todos tab mounts ONE TodoDialog, driven by this discriminated union
  // (see dialogState). It replaced the old two cells — a `todoCaptureOpen`
  // boolean and an `openTodoPath` string — that mounted the dialog TWICE: a
  // capture instance with no live row (which, after ⌘⏎, ran forever on its own
  // local draft and never saw external writes) and an existing instance fed by
  // the live query. Now a capture that commits transitions create→edit and binds
  // to the same live row, so the daemon's generated title, chat-link stamps, and
  // deletes reach the open card.
  const [todoDialog, setTodoDialog] = useState<TodoDialogState>(closedState);
  // Monotonic session token minted on every FRESH open (capture / row click /
  // palette). It's the dialog body's React key; a capture→edit commit keeps the
  // same token, so that transition does not remount (see dialogState).
  const sessionRef = useRef(0);
  const openCapture = useCallback(() => {
    setTodoDialog(createState(++sessionRef.current));
  }, []);
  const openTodo = useCallback((path: string) => {
    setTodoDialog(editState(++sessionRef.current, path));
  }, []);
  const closeTodoDialog = useCallback(() => setTodoDialog(closedState), []);
  // A capture's ⌘⏎ write persisted `path`; bind the dialog to the live row,
  // keeping its session (no remount).
  const commitTodoDialog = useCallback((path: string) => {
    setTodoDialog((prev) => commitState(prev, path));
  }, []);
  // The active per-project view (Todos / Notes / …).
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("todos");
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
  // The live file backing the dialog when it's editing a persisted task (a row
  // click, the palette, OR a capture that committed). Kept live (not snapshotted)
  // so the dialog follows external writes — the daemon auto-titling the task or
  // linking a chat flips the header/footer while the dialog is open. This is now
  // the ONLY source of truth for a persisted todo (no second capture instance
  // forking its own copy).
  const openTodoFile =
    todoDialog.mode === "edit"
      ? files?.find((file) => file.path === todoDialog.path && !file.deleted)
      : undefined;
  const openTodoRow =
    openTodoFile !== undefined
      ? {
          path: openTodoFile.path,
          content: openTodoFile.content,
          updatedAt: openTodoFile.updatedAt,
        }
      : undefined;
  // Close-on-vanish: once files have loaded, if the edited row is gone (deleted
  // here or elsewhere, or tombstoned by the daemon) drop the dialog AND reset the
  // union to closed — the old code hid the existing dialog via `open` but left
  // `openTodoPath` lingering. This now also closes a capture-born saved card if
  // its task is deleted elsewhere (it became edit-mode on commit) — an intended
  // improvement over the old fork, which had no live row to react to.
  useEffect(() => {
    setTodoDialog((prev) =>
      reconcileState(prev, openTodoFile !== undefined, files !== undefined),
    );
  }, [openTodoFile, files]);
  const projectConfig = useMemo(
    () => parseProjectConfig(projectConfigFile?.content, projectId),
    [projectConfigFile?.content, projectId],
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
    void bridge
      .checkIntegrations()
      .then(setIntegrationHealth)
      .catch(() => {
        setIntegrationHealth(null);
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

  // Backfill project.json if it's missing (new project / first sync). The
  // workspace renders fine without it, so a backfill failure is non-fatal.
  useEffect(() => {
    if (!currentProject || files === undefined) return;
    if (projectConfig) return;
    void ensureProjectConfig({ projectId }).catch(() => {});
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

  // `C` captures a todo from anywhere within a project (Decision 10): opens the
  // two-stage capture card into the project's backlog. Ignored while typing in a
  // field or with a todo dialog already open, and when chorded with a modifier
  // (so ⌘C still copies).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (todoDialog.mode !== "closed") return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      ) {
        return;
      }
      e.preventDefault();
      openCapture();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [todoDialog.mode, openCapture]);

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
        integrationHealth={integrationHealth}
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
          onIntegrationHealthChange={setIntegrationHealth}
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

  // Task bodies (tasks/<slug>/task.md). Drop tombstones and any file that isn't
  // a canonical task body. The board is gone; the Todos view derives its own
  // groups, so here we only need slug-uniqueness and the archived surface.
  const taskFiles = files.filter(
    (f) => !f.deleted && taskSlug(f.path) !== null,
  );
  const takenSlugs = taskFiles.map((f) => taskSlug(f.path) as string);

  // Archived todos surface in the settings dialog's Archive tab. Archived is
  // the `archived-at:` timestamp now (Todos v1) — the board's `status: archived` is
  // gone. Unarchive clears the timestamp; Delete tombstones the folder.
  const archivedTodos: ArchivedTodo[] = taskFiles
    .map((f) => ({
      file: f,
      slug: taskSlug(f.path) as string,
      frontmatter: parseFrontmatter(f.content).frontmatter,
    }))
    .filter(
      ({ frontmatter }) => (frontmatter["archived-at"] ?? "").trim() !== "",
    )
    .map(({ file, slug, frontmatter }) => ({
      path: file.path,
      slug,
      title: frontmatter.title || slug,
      content: file.content,
    }));

  // Archived notes surface next to archived todos in the settings dialog's
  // Archive tab.
  const archivedNoteDocs = noteDocs(files).filter((d) => d.archived);

  // The command palette's task list = the derived todo groups (frontmatter-only
  // mode; the palette isn't perf-sensitive and needs no live chat index).
  const todoGroups = deriveTodoGroups(files, backlogOrder);

  // Write a todo's materialized file (path + full content already resolved by
  // the TodoDialog) through the optimistic upsert, so the row reflects instantly
  // — the capture dialog uses this to persist a saved/delegated todo.
  async function materializeDraftFile(path: string, content: string) {
    await upsertFile({
      projectId,
      path,
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  // Check/uncheck a todo: stamp (or clear) `completed-at` in the task.md
  // frontmatter through the same optimistic upsert everything else uses, so the
  // row moves between BACKLOG/… and DONE instantly. Unchecking also returns the
  // todo to the TOP of Backlog (Decision 8): prepend its path to the manual
  // order (dedup) so it lands above existing items rather than in the absentee
  // block. An agent writing `completed-at` itself is honored the same way
  // (Decision 7).
  async function setTodoCompleted(todo: Todo, completed: boolean) {
    const nextContent = setFrontmatterKeys(todo.content, {
      "completed-at": completed ? new Date().toISOString() : undefined,
    });
    if (!completed) {
      // Prepend before the file write so the row is already pinned to the top
      // when the derivation re-runs against the cleared completed-at.
      void setBacklogOrder({
        projectId,
        order: prependBacklogPath(backlogOrderRef.current, todo.path),
      }).catch((err) =>
        console.error("Failed to prepend unchecked todo to backlog", err),
      );
    }
    await upsertFile({
      projectId,
      path: todo.path,
      content: nextContent,
      hash: await sha256(nextContent),
      deleted: false,
    });
    // Done means done: close the chat's tab too, even mid-turn — the transcript
    // survives on disk, so clicking the chat later resumes it (fully
    // reversible). Only manual checks close; agent-stamped `completed-at`
    // doesn't pass through here, so an agent finishing its own task is never
    // killed mid-final-message. The command carries the lifecycle invariants
    // rather than trusting this moment: `environment` pins the environment
    // that owns the live tab (not the launcher preference at execution time),
    // and `linkedPath` lets the daemon re-check at execution that the task is
    // still completed and still bound to this chat (a quick uncheck between
    // enqueue and claim drops the close instead of killing the tab).
    if (completed && todo.chat) {
      void enqueueCommand({
        projectId,
        kind: "close-chat",
        harness: todo.chat.harness,
        environment: todo.chat.env,
        sessionId: todo.chat.id,
        cwd: todo.chat.cwd,
        linkedType: "task",
        linkedPath: todo.path,
      }).catch((err) =>
        console.error("Failed to enqueue close-chat for done todo", err),
      );
    }
    // Offer an undo: a done row drops to the bottom of a truncated DONE group,
    // so an accidental check is a pain to walk back by hand. Undo re-runs this
    // with completed=false — which also re-pins the row to the top of Backlog
    // (above) and, because the close-chat command re-checks `linkedPath` at
    // execution, a quick undo can still cancel the tab close before it fires
    // (PR #68). Only manual checks reach here, so an agent finishing its own
    // task never triggers a toast.
    if (completed) {
      const toastContext: TaskToastContext = {
        title: todo.title,
        chat: todo.chat,
      };
      showUndoableToast({
        message: "Task marked done",
        ...taskToastPayload(
          toastContext,
          todo.chat ? "Its chat is closing." : undefined,
        ),
        stack: true,
        undo: () => void setTodoCompleted(todo, false),
      });
    }
  }

  async function archiveTodoContentWithUndo(
    path: string,
    content: string,
    fallbackTitle: string,
  ) {
    const nextContent = setFrontmatterKeys(content, {
      "archived-at": new Date().toISOString(),
    });
    await upsertFile({
      projectId,
      path,
      content: nextContent,
      hash: await sha256(nextContent),
      deleted: false,
    });
    const toastContext = taskToastContext(content, fallbackTitle);
    showUndoableToast({
      message: "Task archived",
      ...taskToastPayload(toastContext),
      stack: true,
      undo: () =>
        void (async () => {
          await upsertFile({
            projectId,
            path,
            content,
            hash: await sha256(content),
            deleted: false,
          });
        })().catch((err) =>
          console.error("Failed to restore archived todo", err),
        ),
    });
  }

  async function archiveTodoWithUndo(todo: Todo) {
    await archiveTodoContentWithUndo(todo.path, todo.content, todo.title);
  }

  // Unarchive a todo: clear its `archived-at:` timestamp so the derivation
  // regroups it. Todos v1 archived model — this never writes `status:`.
  async function unarchiveTodo(todo: ArchivedTodo) {
    const nextContent = setFrontmatterKeys(todo.content, {
      "archived-at": undefined,
    });
    await upsertFile({
      projectId,
      path: todo.path,
      content: nextContent,
      hash: await sha256(nextContent),
      deleted: false,
    });
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

  // Delete a todo folder by slug (attachments + task.md tombstone). The raw,
  // silent delete — used by the capture dialog's discard-cleanup of a
  // pasted-early draft (Decision 3), which is an intentional throwaway, not a
  // "you deleted a task" the user would want to undo.
  async function deleteTodo(slug: string) {
    await cascadeDeleteAttachments(slug);
    const path = taskBodyPath(slug);
    await upsertFile({ projectId, path, content: "", hash: "", deleted: true });
  }

  // Everything needed to bring a deleted todo/note back: its file content plus
  // the attachment rows that were tombstoned. Tombstoning drops the local blob
  // but leaves the server blob (GC is out of scope), so re-registering the same
  // storageId re-points at it — the undo is lossless within the toast window.
  type DeletedSnapshot = {
    path: string;
    content: string;
    attachments: NonNullable<typeof attachments>;
  };

  function snapshotTodo(slug: string): DeletedSnapshot {
    const path = taskBodyPath(slug);
    const file = files?.find((f) => f.path === path && !f.deleted);
    const prefix = `tasks/${slug}/attachments/`;
    return {
      path,
      content: file?.content ?? "",
      attachments: (attachments ?? []).filter(
        (row) => !row.deleted && row.path.startsWith(prefix),
      ),
    };
  }

  async function restoreDeleted(snap: DeletedSnapshot) {
    await upsertFile({
      projectId,
      path: snap.path,
      content: snap.content,
      hash: await sha256(snap.content),
      deleted: false,
    });
    await Promise.all(
      snap.attachments.map((row) =>
        registerAttachment({
          projectId,
          path: row.path,
          storageId: row.storageId,
          hash: row.hash,
          contentType: row.contentType,
          size: row.size,
        }),
      ),
    );
  }

  // The user-facing todo delete (⋯ Delete, archived sheet row): snapshot first,
  // tombstone, then offer an undo. Distinct from `deleteTodo` so the silent
  // discard-cleanup path stays toast-free.
  async function deleteTodoWithUndo(slug: string) {
    const snap = snapshotTodo(slug);
    const toastContext = taskToastContext(snap.content, slug);
    await deleteTodo(slug);
    showUndoableToast({
      message: "Task deleted",
      ...taskToastPayload(toastContext),
      stack: true,
      undo: () =>
        void restoreDeleted(snap).catch((err) =>
          console.error("Failed to restore deleted todo", err),
        ),
    });
  }

  // Delete every archived todo in one shot. Snapshots them all first so a single
  // undo restores the whole batch; the optimistic tombstones drop each row
  // immediately.
  async function deleteAllArchived() {
    const snaps = archivedTodos.map((todo) => snapshotTodo(todo.slug));
    await Promise.all(archivedTodos.map((todo) => deleteTodo(todo.slug)));
    if (snaps.length) {
      showUndoableToast({
        message: `${snaps.length} task${snaps.length > 1 ? "s" : ""} deleted`,
        undo: () =>
          void Promise.all(snaps.map(restoreDeleted)).catch((err) =>
            console.error("Failed to restore deleted todos", err),
          ),
      });
    }
  }

  // Unarchive a note: clear its `archived:` flag so it rejoins the Notes index.
  async function unarchiveNote(doc: NoteDoc) {
    const nextContent = setFrontmatterKeys(doc.content, {
      archived: undefined,
    });
    await upsertFile({
      projectId,
      path: doc.path,
      content: nextContent,
      hash: await sha256(nextContent),
      deleted: false,
    });
  }

  // Delete an archived note from the Archive tab. Mirrors NotesView's
  // deleteDocWithUndo: tombstone the attachment rows and the body, then offer
  // an undo that re-writes the body and re-registers each attachment against
  // its surviving server blob (GC is out of scope).
  async function deleteNoteWithUndo(doc: NoteDoc) {
    const prefix = `notes/${doc.slug}/attachments/`;
    const revivable = (attachments ?? []).filter(
      (row) => !row.deleted && row.path.startsWith(prefix),
    );
    await Promise.all(
      revivable.map((row) => tombstoneAttachment({ projectId, path: row.path })),
    );
    await upsertFile({
      projectId,
      path: doc.path,
      content: "",
      hash: "",
      deleted: true,
    });
    showUndoableToast({
      message: "Note deleted",
      undo: () =>
        void (async () => {
          await upsertFile({
            projectId,
            path: doc.path,
            content: doc.content,
            hash: await sha256(doc.content),
            deleted: false,
          });
          await Promise.all(
            revivable.map((row) =>
              registerAttachment({
                projectId,
                path: row.path,
                storageId: row.storageId,
                hash: row.hash,
                contentType: row.contentType,
                size: row.size,
              }),
            ),
          );
        })().catch((err) =>
          console.error("Failed to restore deleted note", err),
        ),
    });
  }

  // Everything the settings dialog's Archive tab renders: archived todos and
  // notes as ready-made rows, each bound to the same unarchive/delete (+ undo)
  // handlers the old side sheets used.
  const projectArchive: ProjectArchive = {
    todos: archivedTodos.map((todo) => ({
      key: todo.slug,
      title: todo.title,
      detail: todo.path,
      onUnarchive: () => void unarchiveTodo(todo),
      onDelete: () => void deleteTodoWithUndo(todo.slug),
    })),
    notes: archivedNoteDocs.map((doc) => ({
      key: doc.slug,
      title: doc.title,
      detail: doc.type,
      onUnarchive: () => void unarchiveNote(doc),
      onDelete: () => void deleteNoteWithUndo(doc),
    })),
    onDeleteAllTodos: () => void deleteAllArchived(),
  };

  // Command palette (⌘K) data + actions. Active-project scoped: its task/note
  // lists are the live todos/notes; the project list drives the switcher.
  const paletteProjects = projects.map(({ project }) => ({
    id: project._id,
    name: project.name,
  }));
  const PALETTE_GROUP_LABEL: Record<Todo["group"], string> = {
    "needs-you": "Needs you",
    working: "Working",
    backlog: "Backlog",
    done: "Done",
  };
  const paletteTasks = [
    ...todoGroups.needsYou,
    ...todoGroups.working,
    ...todoGroups.backlog,
    ...todoGroups.done,
  ].map((todo) => ({
    path: todo.path,
    title: todo.title,
    meta: PALETTE_GROUP_LABEL[todo.group],
  }));
  const paletteNotes = noteDocs(files)
    .filter((doc) => !doc.archived)
    .map((doc) => ({ slug: doc.slug, title: doc.title, meta: doc.type }));
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
    {
      id: "editor-sandbox",
      title: "Editor Sandbox",
      meta: "internal",
      keywords: ["editor", "sandbox", "lexical", "playground"],
      icon: <PencilIcon className="size-4" />,
      onRun: () => setWorkspaceView("editor-sandbox"),
    },
  ];

  // Open a todo: switch to the Todos view and open the TodoDialog over it.
  function paletteOpenTask(path: string) {
    setWorkspaceView("todos");
    openTodo(path);
  }
  // New todo: switch to the Todos view and open the two-stage capture card. The
  // capture card is body-only (Decision 10), so the typed query isn't seeded.
  function paletteCreateTask(_title: string) {
    setWorkspaceView("todos");
    openCapture();
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

  return (
    <AppShell
      projects={projects}
      selectedProjectId={projectId}
      creatingProject={creatingProject}
      onSelectProject={onSelectProject}
      onCreateProject={onCreateProject}
      onOpenProjectSettings={openProjectSettingsFor}
      harnessSetup={globalHarnessSetup}
      integrationHealth={integrationHealth}
      keepAwake={keepAwake}
      onToggleKeepAwake={() => void toggleKeepAwake()}
      onShowGlobalSettings={openGlobalSettings}
      onShowDebug={() => setWorkspaceView("debug")}
      onShowEditorSandbox={() => setWorkspaceView("editor-sandbox")}
      onSignOut={() => void signOut()}
      onOpenPalette={() => setShowPalette(true)}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Title | tabs | settings. The equal 1fr side columns keep the view
            tabs centered on the window regardless of how long the project name
            runs (it truncates before it can push them). The header owns its own
            horizontal padding; the wrapper adds none, so the grey rule spans the
            full width and each page below runs flush up to it. */}
        <header className="window-titlebar-row grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 overflow-hidden border-b border-border bg-background px-4 sm:px-6 lg:px-8">
          <h1 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {currentProject.name}
          </h1>
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
          <div className="flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openProjectDetails()}
            >
              <SettingsIcon />
              Project settings
            </Button>
          </div>
        </header>

        {localConfigReady && !projectIsHitched && (
          <section className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-amber-500/10 p-3 text-sm sm:mx-6 lg:mx-8">
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
            onExit={() => setWorkspaceView("todos")}
            intent={noteIntent}
            onIntentHandled={() => setNoteIntent(null)}
          />
        ) : workspaceView === "automations" ? (
          <AutomationsView
            projectId={projectId}
            files={files}
            intent={automationIntent}
            onIntentHandled={() => setAutomationIntent(null)}
            onExit={() => setWorkspaceView("todos")}
          />
        ) : workspaceView === "debug" ? (
          <DebugView
            projectId={projectId}
            onExit={() => setWorkspaceView("todos")}
          />
        ) : workspaceView === "editor-sandbox" ? (
          <SandboxEditor onExit={() => setWorkspaceView("todos")} />
        ) : (
          <TodosView
            projectId={projectId}
            files={files}
            // ↑↓/↵ list nav is live only when no todo dialog is over the list.
            // (Other overlays — palette, settings dialogs — are role="dialog"
            // and the hook's own target guard defers to them.)
            active={todoDialog.mode === "closed"}
            onOpenTodo={(path) => openTodo(path)}
            onAddTodo={() => openCapture()}
            onToggleCompleted={(todo, completed) =>
              void setTodoCompleted(todo, completed)
            }
            onArchiveTodo={(todo) => void archiveTodoWithUndo(todo)}
            onWriteTodo={(path, content) =>
              void materializeDraftFile(path, content)
            }
            onDeleteTodo={(slug) => void deleteTodoWithUndo(slug)}
          />
        )}

        <GlobalSettingsDialog
          open={showGlobalSettings}
          onOpenChange={setShowGlobalSettings}
          initialTab={globalSettingsTab}
          onLocalConfigChange={onLocalConfigChange}
          onHarnessSetupChange={setGlobalHarnessSetup}
          onIntegrationHealthChange={setIntegrationHealth}
        />

        <ProjectDetailsDialog
          projectId={projectId}
          open={showProjectDetails}
          onOpenChange={setShowProjectDetails}
          onLocalConfigChange={onLocalConfigChange}
          initialTab={projectDetailsTab}
          archive={projectArchive}
        />

        {/* ONE TodoDialog for the whole Todos tab (single-binding). It's a fresh
            two-stage capture in create mode; in edit mode it's bound to the live
            `files` row (`openTodoRow`) — a row click, the palette, OR a capture
            that just committed (onCommitted flips create→edit). The row comes
            from the live subscription, so the header/footer follow external
            writes (the daemon auto-titling, linking a chat, projecting status).
            If the row vanishes, the close-on-vanish effect above resets to
            closed. There is no longer a second instance forking a private copy of
            a persisted todo. */}
        <TodoDialog
          state={todoDialog}
          projectId={projectId}
          row={openTodoRow}
          takenSlugs={takenSlugs}
          onClose={closeTodoDialog}
          onCommitted={commitTodoDialog}
          onWrite={materializeDraftFile}
          onDeleteTodo={deleteTodo}
          onUserDeleteTodo={(slug) => void deleteTodoWithUndo(slug)}
          onUserArchiveTodo={(path, content) =>
            void archiveTodoContentWithUndo(
              path,
              content,
              taskSlug(path) ?? "task",
            )
          }
          onManagePrompts={() => openGlobalSettings("starting-prompts")}
          onManageHarnesses={() => openGlobalSettings("harnesses")}
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
          actions={paletteActions}
          onSelectProject={onSelectProject}
          onSelectView={setWorkspaceView}
          onOpenTask={paletteOpenTask}
          onCreateTask={paletteCreateTask}
          onOpenNote={paletteOpenNote}
          onCreateNote={paletteCreateNote}
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

export default function AppRoot() {
  // ⌘Z fires the undo of whatever undoable toast is currently showing (done
  // check, delete). Mounted here so it's live across every view; it's inert
  // unless a toast is up (see useUndoHotkey).
  useUndoHotkey();
  return (
    <>
      <AuthenticatedWorkspace />
      <ProjectConflictDialog />
      {/* App-styled spellcheck context menu — replaces the native OS menu across
          every editable surface (title, composer, body editor). */}
      <SpellcheckMenu />
      <Toaster richColors position="bottom-right" expand visibleToasts={6} />
    </>
  );
}
