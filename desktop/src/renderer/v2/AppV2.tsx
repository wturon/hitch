import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";
import {
  ChevronUpIcon,
  InboxIcon,
  LogOutIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";

import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import {
  CommandPalette,
  type PaletteProject,
  type PaletteTask,
} from "@/components/CommandPalette";
import {
  GlobalSettingsDialog,
  type GlobalSettingsTab,
} from "@/components/GlobalSettingsDialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Toaster } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHitchServer } from "@/lib/server/HitchServerProvider";
import type { HitchClient } from "@/lib/server/client";
import { useUndoHotkey } from "@/lib/undoToast";
import { cn } from "@/lib/utils";
import { ConnectionBanner } from "./ConnectionBanner";
import { TaskDialogV2, type TaskDialogActions } from "./TaskDialogV2";
import {
  captureState,
  closedTaskDialog,
  commitTaskState,
  editTaskState,
  reconcileTaskDialog,
  type TaskDialogState,
} from "./taskDialogState";
import { deriveTaskGroups } from "./todoGroups";
import { fetchTasks, TodosViewV2 } from "./TodosViewV2";
import { useTagMutations } from "./useTagMutations";
import { useTaskMutations } from "./useTaskMutations";

// The V2 shell (M2 PR 2): sidebar + header + TodosViewV2, mirroring V1's
// chrome so switching modes feels like the same app — same rail classes, same
// titlebar row, same monochrome register. Deliberately absent (vs V1): view
// tabs (Todos is the only V2 view), Automations, Archive, pins/status chips
// (M4). CreateProjectDialog and CommandPalette are V1's own components,
// imported — they are pure presentation.
//
// ⌘K (PR 7): V1's CommandPalette, scoped like V1 to the ACTIVE project —
// fuzzy-open a task, capture a new one, switch/create projects. V1's actions
// group remains deliberately empty here: global settings live in the account
// footer, while V1-only actions such as the editor sandbox stay out of V2.
//
// Inbox: on boot a project named "Inbox" is ensured (created if missing),
// pinned first in the rail, and is the default selection.

const INBOX_NAME = "Inbox";
// Same key as V1's rail so the collapse preference carries across modes.
const SIDEBAR_COLLAPSED_KEY = "hitch:sidebar:collapsed";
const SELECTED_PROJECT_KEY = "hitch:v2:selected-project";
const V2_SETTINGS_TABS = [
  "harnesses",
  "integrations",
  "appearance",
  "starting-prompts",
  "updates",
] as const satisfies readonly GlobalSettingsTab[];

const inputClass =
  "h-9 w-full min-w-0 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function WindowDragRegion() {
  return <div className="window-drag-region" aria-hidden />;
}

function SignInScreen() {
  const { signIn, signUp } = useHitchServer();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result =
      mode === "sign-in"
        ? await signIn({ email, password })
        : await signUp({ email, password, name: name || email });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
    }
  }

  return (
    <>
      <WindowDragRegion />
      <main className="flex min-h-screen items-center justify-center p-8 pt-14">
        <section className="flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {mode === "sign-in" ? "Sign in to Hitch" : "Create your Hitch account"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Email and password for your Hitch server.
            </p>
          </div>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            {mode === "sign-up" && (
              <input
                className={inputClass}
                type="text"
                placeholder="Name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            <input
              className={inputClass}
              type="email"
              placeholder="Email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <input
              className={inputClass}
              type="password"
              placeholder="Password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" disabled={pending}>
              {pending
                ? "Working..."
                : mode === "sign-in"
                  ? "Sign in"
                  : "Sign up"}
            </Button>
          </form>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError(null);
            }}
          >
            {mode === "sign-in"
              ? "New here? Create an account"
              : "Already have an account? Sign in"}
          </button>
        </section>
      </main>
    </>
  );
}

async function fetchProjects(client: HitchClient) {
  const response = await client.projects.$get();
  if (!response.ok) throw new Error(`Failed to list projects (${response.status})`);
  return await response.json();
}

type ProjectItem = Awaited<ReturnType<typeof fetchProjects>>[number];

// The rail toggle, verbatim from V1's App shell: pinned to the window's
// top-left strip just right of the macOS traffic lights, so it survives the
// rail sliding off-canvas.
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

// One project in the rail — V1's ProjectRow chrome without its Convex freight
// (pins, status chips, context menu: all M4-or-later). Inbox swaps the muted
// `#` glyph for an inbox mark; everything else is identical.
function ProjectRowV2({
  project,
  selected,
  onSelect,
}: {
  project: ProjectItem;
  selected: boolean;
  onSelect: (projectId: string) => void;
}) {
  const isInbox = project.name === INBOX_NAME;
  return (
    <button
      type="button"
      data-testid="v2-project-row"
      aria-current={selected}
      onClick={() => onSelect(project.id)}
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-2 text-left transition-colors",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
      )}
    >
      <span
        className={cn(
          "flex w-4 shrink-0 items-center justify-center font-mono text-[15px] leading-none",
          selected ? "text-sidebar-foreground/70" : "text-sidebar-foreground/40",
        )}
        aria-hidden
      >
        {isInbox ? <InboxIcon className="size-3.5" /> : "#"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-normal">
        {project.name}
      </span>
    </button>
  );
}

// The rail's footer identity control — V1's AccountFooter silhouette (avatar
// row opening an upward menu), with V2-safe settings plus server identity and
// sign-out. Harness-health and keep-awake status remain outside this slim shell.
function AccountFooterV2({
  serverUrl,
  onShowSettings,
  onSignOut,
}: {
  serverUrl: string;
  onShowSettings: () => void;
  onSignOut: () => void;
}) {
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
        <span
          className="flex size-6.5 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white"
          style={{ backgroundImage: "linear-gradient(140deg, #595959, #8a8a8a)" }}
          aria-hidden
        >
          H
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-[13px] font-medium md:inline">
          Account
        </span>
        <ChevronUpIcon className="hidden size-3.5 shrink-0 text-sidebar-foreground/55 md:block" />
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[var(--anchor-width)] min-w-56 p-1.5"
      >
        <div className="flex min-w-0 flex-col px-2 pb-2 pt-1.5">
          <span className="text-[13px] font-semibold text-popover-foreground">
            Hitch server
          </span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {serverUrl}
          </span>
        </div>
        <div className="my-0.5 h-px bg-border" />
        <MenuItem onClick={onShowSettings}>
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

function SidebarV2({
  projects,
  selectedProjectId,
  collapsed,
  creatingProject,
  serverUrl,
  onSelectProject,
  onCreateProject,
  onShowSettings,
  onSignOut,
}: {
  projects: ProjectItem[];
  selectedProjectId: string | null;
  collapsed: boolean;
  creatingProject: boolean;
  serverUrl: string;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onShowSettings: () => void;
  onSignOut: () => void;
}) {
  const [showCreateProject, setShowCreateProject] = useState(false);

  return (
    <aside
      className={cn(
        "window-sidebar flex shrink-0 items-center gap-3 border-b bg-sidebar px-3 pb-2 pt-10 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-64 md:flex-col md:items-stretch md:border-b-0 md:border-r md:border-sidebar-border md:px-3 md:pb-4 md:pt-12",
        // Same off-canvas collapse as V1: keep the width, slide via margin.
        "md:transition-[margin] md:duration-200 md:ease-in-out",
        collapsed && "md:-ml-64",
      )}
    >
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
        ) : (
          projects.map((project) => (
            <ProjectRowV2
              key={project.id}
              project={project}
              selected={project.id === selectedProjectId}
              onSelect={onSelectProject}
            />
          ))
        )}
      </nav>

      <CreateProjectDialog
        open={showCreateProject}
        onOpenChange={setShowCreateProject}
        creating={creatingProject}
        onCreate={onCreateProject}
      />

      <div className="ml-auto flex items-center gap-1 md:ml-0 md:mt-auto md:flex-col md:items-stretch md:border-t md:border-sidebar-border md:pt-2">
        <AccountFooterV2
          serverUrl={serverUrl}
          onShowSettings={onShowSettings}
          onSignOut={onSignOut}
        />
      </div>
    </aside>
  );
}

function WorkspaceV2({ client }: { client: HitchClient }) {
  const { serverUrl, signOut } = useHitchServer();
  const queryClient = useQueryClient();
  const [showSettings, setShowSettings] = useState(false);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(client),
  });

  // --- Inbox ensure-by-name -------------------------------------------------
  // Once the project list has loaded, create "Inbox" if it's missing. The ref
  // caps it at one in-flight attempt (StrictMode's double effect included) —
  // race-safe enough for a single client; a failure re-arms so a later refetch
  // retries.
  const ensuringInbox = useRef(false);
  useEffect(() => {
    const rows = projects.data;
    if (!rows || ensuringInbox.current) return;
    if (rows.some((project) => project.name === INBOX_NAME)) return;
    ensuringInbox.current = true;
    void (async () => {
      try {
        // Before every existing project, so it also SORTS first server-side.
        const sortOrder = generateKeyBetween(null, rows[0]?.sortOrder ?? null);
        const response = await client.projects.$post({
          json: { name: INBOX_NAME, sortOrder },
        });
        if (!response.ok) throw new Error(`Failed to create Inbox (${response.status})`);
      } catch (error) {
        console.error("Failed to ensure Inbox project", error);
        ensuringInbox.current = false;
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }
    })();
  }, [projects.data, client, queryClient]);

  // Inbox pinned first; the rest keep the server's sortOrder ordering.
  const orderedProjects = useMemo(() => {
    const rows = projects.data ?? [];
    const inbox = rows.find((project) => project.name === INBOX_NAME);
    return inbox ? [inbox, ...rows.filter((project) => project !== inbox)] : rows;
  }, [projects.data]);

  // --- Selection (persisted per device, like V1's rail prefs) ---------------
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(SELECTED_PROJECT_KEY),
  );
  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    window.localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
  }
  // Reconcile once projects load: a stale/absent selection falls back to Inbox
  // (the default surface), then to whatever exists.
  useEffect(() => {
    const rows = projects.data;
    if (!rows || rows.length === 0) return;
    if (selectedProjectId && rows.some((p) => p.id === selectedProjectId)) return;
    const fallback = rows.find((p) => p.name === INBOX_NAME) ?? rows[0];
    selectProject(fallback.id);
  }, [projects.data, selectedProjectId]);

  const selectedProject =
    orderedProjects.find((p) => p.id === selectedProjectId) ?? null;

  // --- Task dialog (M2 PR 3) ------------------------------------------------
  // ONE TaskDialogV2, driven by the discriminated union — V1's single-binding
  // pattern (see taskDialogState). The dialog's live row + backlog head come
  // from the SAME query key TodosViewV2 uses (["tasks", { projectId }]), so
  // the two surfaces share one cache entry — the live query stays the only
  // truth for a persisted task.
  const [taskDialog, setTaskDialog] = useState<TaskDialogState>(closedTaskDialog);
  // Monotonic session token minted on every FRESH open (add-row / `C` / row
  // click). It's the dialog body's React key; a capture→edit commit keeps the
  // same token, so that transition does not remount (see taskDialogState).
  const sessionRef = useRef(0);
  const openCapture = useCallback(() => {
    setTaskDialog(captureState(++sessionRef.current));
  }, []);
  const openTask = useCallback((taskId: string) => {
    setTaskDialog(editTaskState(++sessionRef.current, taskId));
  }, []);
  const closeTaskDialog = useCallback(() => setTaskDialog(closedTaskDialog), []);
  // A capture's ⌘⏎ POST persisted the task; bind the dialog to the live row,
  // keeping its session (no remount).
  const commitTaskDialog = useCallback((taskId: string) => {
    setTaskDialog((prev) => commitTaskState(prev, taskId));
  }, []);

  // The list mutations (PR 4): ONE instance for the whole workspace, so the
  // list rows, the keyboard shortcuts and the dialog ⋯ menu share the same
  // optimistic cache and the same pending-delete window.
  const taskMutations = useTaskMutations(client, selectedProject?.id ?? null);
  // The tag data layer (PR 5): same one-instance rule — the row's Tags ▸
  // submenu, the filter bar and the dialog's tag lane all read/write through
  // these handlers (and the one optimistic tagIds cache).
  const tagActions = useTagMutations(client, selectedProject?.id ?? null);

  const dialogTasks = useQuery({
    queryKey: ["tasks", { projectId: selectedProject?.id }],
    queryFn: () => fetchTasks(client, selectedProject!.id),
    enabled: selectedProject !== null,
  });
  const dialogRow =
    taskDialog.mode === "edit"
      ? dialogTasks.data?.find(
          (task) =>
            task.id === taskDialog.taskId &&
            // A task in its delete window has vanished as far as the UI is
            // concerned: treating it as absent here lets close-on-vanish
            // (below) drop an open dialog the moment its task is deleted —
            // from the dialog's own ⋯ menu included.
            !taskMutations.pendingDeleteIds.has(task.id),
        )
      : undefined;
  // One grouping fold shared by the dialog's backlog-prepend maths and the
  // ⌘K palette's task list — both read the same query, so this derives once.
  const taskGroups = useMemo(
    () => deriveTaskGroups(dialogTasks.data ?? []),
    [dialogTasks.data],
  );
  const dialogBacklog = taskGroups.backlog;
  // Close-on-vanish: once tasks have loaded, if the edited row is gone
  // (deleted from another client) drop the dialog AND reset the union.
  useEffect(() => {
    setTaskDialog((prev) =>
      reconcileTaskDialog(prev, dialogRow !== undefined, dialogTasks.data !== undefined),
    );
  }, [dialogRow, dialogTasks.data]);
  // The dialog ⋯ menu's actions, bound to the live row through the SAME
  // mutation handlers the list rows use (one code path, one undo toast).
  const dialogActions: TaskDialogActions | undefined = dialogRow
    ? {
        completed: dialogRow.status === "done",
        onToggleCompleted: () =>
          taskMutations.toggleDone(dialogRow, dialogRow.status !== "done"),
        onDelete: () => taskMutations.deleteTaskWithUndo(dialogRow),
      }
    : undefined;
  // The dialog's tag lane (PR 5), bound to the live row through the SAME
  // useTagMutations handlers the row submenu uses — the lane's pills are the
  // live row's tagIds resolved to names, so an optimistic link/unlink shows
  // in the dialog and the list in the same render.
  const dialogTags = dialogRow
    ? {
        names: tagActions.namesOf(dialogRow),
        colorOf: tagActions.colorOf,
        options: tagActions.options,
        onToggle: (name: string) => tagActions.toggleTag(dialogRow, name),
        onCreate: (name: string) => tagActions.createTag(dialogRow, name),
      }
    : undefined;

  // ⌘Z targets the newest visible undo toast (delete / mark-done); inert
  // otherwise. Mounted once for the workspace, like V1's App root.
  useUndoHotkey();

  // `C` captures a task from anywhere within a project (V1 Decision 10, same
  // shortcut): opens the capture card into the project's backlog. Ignored
  // while typing in a field, with the dialog already open, or when chorded
  // with a modifier (so ⌘C still copies).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (taskDialog.mode !== "closed" || !selectedProject) return;
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
  }, [taskDialog.mode, selectedProject, openCapture]);

  // --- ⌘K command palette (PR 7) --------------------------------------------
  // V1's palette, active-project scoped: fuzzy-open a task, capture, switch or
  // create a project. The actions group is empty on purpose (V1-only surfaces).
  const [showPalette, setShowPalette] = useState(false);
  // Palette-driven "New project" reuses the sidebar dialog, pre-filled with
  // the typed query (V1's exact pattern).
  const [createProjectName, setCreateProjectName] = useState<string | null>(null);

  // ⌘K (Ctrl+K) toggles the palette — V1's exact gating: when open, close.
  // When closed, suppress only where ⌘K means something else or the palette
  // shouldn't appear: a contenteditable (the editor owns ⌘K for links) or
  // while another dialog/menu is up (the task dialog included).
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
      // One refinement over V1's selector: Base UI keeps a dismissed popup
      // mounted (with data-closed) until its exit animation ends — that
      // corpse shouldn't swallow a ⌘K that lands mid-fade.
      if (
        document.querySelector(
          '[role="dialog"]:not([data-closed]),[role="alertdialog"]:not([data-closed]),[role="menu"]:not([data-closed])',
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

  // The palette's searchable rows. Ids stand in for V1's task paths (the
  // palette's opaque selection key), and the group ordering mirrors V1:
  // attention first, then backlog in manual order, done last.
  const paletteProjects: PaletteProject[] = orderedProjects.map((project) => ({
    id: project.id as PaletteProject["id"],
    name: project.name,
  }));
  const paletteTasks: PaletteTask[] = useMemo(
    () =>
      [
        ...taskGroups.needsYou.map((task) => ({ task, meta: "Needs you" })),
        ...taskGroups.working.map((task) => ({ task, meta: "Working" })),
        ...taskGroups.backlog.map((task) => ({ task, meta: "Backlog" })),
        ...taskGroups.done.map((task) => ({ task, meta: "Done" })),
      ].map(({ task, meta }) => ({ path: task.id, title: task.title, meta })),
    [taskGroups],
  );

  // --- New project (the one write this PR keeps) ----------------------------
  const createProject = useMutation({
    mutationFn: async (projectName: string) => {
      const rows = projects.data ?? [];
      const sortOrder = generateKeyBetween(rows.at(-1)?.sortOrder ?? null, null);
      const response = await client.projects.$post({
        json: { name: projectName, sortOrder },
      });
      if (!response.ok) throw new Error(`Failed to create project (${response.status})`);
      return await response.json();
    },
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      selectProject(project.id);
    },
  });

  // --- Rail collapse (V1's exact behavior, same storage key) ----------------
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  });
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
  }, [collapsed]);
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
      <SidebarV2
        projects={orderedProjects}
        selectedProjectId={selectedProjectId}
        collapsed={collapsed}
        creatingProject={createProject.isPending}
        serverUrl={serverUrl}
        onSelectProject={selectProject}
        onCreateProject={async (name) => {
          await createProject.mutateAsync(name);
        }}
        onShowSettings={() => setShowSettings(true)}
        onSignOut={() => void signOut()}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* V1's titlebar row, minus the view switcher (Todos is the only V2
              view) and project settings (nothing to configure yet). The empty
              grid columns keep the layout — and the drag region — identical. */}
          <header className="window-titlebar-row grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 overflow-hidden border-b border-border bg-background px-4 sm:px-6 lg:px-8">
            <h1 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
              {selectedProject?.name ?? ""}
            </h1>
            <div />
            <div />
          </header>

          {projects.isError ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-destructive">
              {String(projects.error)}
            </div>
          ) : selectedProject ? (
            <TodosViewV2
              client={client}
              projectId={selectedProject.id}
              // Keyboard nav is live only while no dialog floats above the
              // list (V1's `active` contract).
              active={taskDialog.mode === "closed"}
              pendingDeleteIds={taskMutations.pendingDeleteIds}
              tag={tagActions}
              onOpenTask={openTask}
              onAddTask={openCapture}
              onToggleDone={taskMutations.toggleDone}
              onReorderTask={taskMutations.reorderTask}
              onDeleteTask={taskMutations.deleteTaskWithUndo}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              {projects.isPending ? "Loading projects…" : "Setting up your Inbox…"}
            </div>
          )}
        </div>
      </main>
      {/* The single task-dialog mount (PR 3). Gated on a selected project —
          capture needs a projectId to create into, and the union can only be
          opened from inside a project. */}
      {selectedProject && (
        <TaskDialogV2
          state={taskDialog}
          client={client}
          projectId={selectedProject.id}
          row={dialogRow}
          backlog={dialogBacklog}
          actions={dialogActions}
          tags={dialogTags}
          onClose={closeTaskDialog}
          onCommitted={commitTaskDialog}
        />
      )}
      {/* ⌘K (PR 7). Gated on a selected project like the task dialog — the
          palette is active-project scoped and captures into it. `New task`
          opens the capture card body-only (V1 Decision 10: the typed query is
          not seeded); `New project` re-uses the sidebar dialog below. */}
      {selectedProject && (
        <CommandPalette
          open={showPalette}
          onOpenChange={setShowPalette}
          projects={paletteProjects}
          activeProjectId={selectedProject.id as PaletteProject["id"]}
          activeProjectName={selectedProject.name}
          currentView="todos"
          tasks={paletteTasks}
          actions={[]}
          onSelectProject={selectProject}
          onSelectView={() => {}}
          onOpenTask={openTask}
          onCreateTask={() => openCapture()}
          onCreateProject={(name) => setCreateProjectName(name)}
        />
      )}
      {/* Palette-driven "New project", pre-filled with the typed query. */}
      <CreateProjectDialog
        open={createProjectName !== null}
        onOpenChange={(open) => {
          if (!open) setCreateProjectName(null);
        }}
        creating={createProject.isPending}
        onCreate={async (name) => {
          await createProject.mutateAsync(name);
        }}
        initialName={createProjectName ?? undefined}
      />
      <GlobalSettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        visibleTabs={V2_SETTINGS_TABS}
        description="Manage this Mac's agent setup, appearance, prompts, and app updates."
        contentClassName="h-[760px] sm:max-w-[min(64rem,calc(100%-2rem))]"
      />
      {/* Server-unreachable pill (PR 7): floats under the titlebar, shows on
          WS loss or failing queries, self-dismisses on recovery. */}
      <ConnectionBanner />
      {/* The undo-toast surface (V1's exact mount: sonner, bottom-right). */}
      <Toaster richColors position="bottom-right" expand visibleToasts={6} />
      {/* Rendered last so its no-drag region is subtracted after the sidebar
          and titlebar drag regions are unioned (Electron resolves overlapping
          app-regions in DOM order — see V1's App shell). */}
      <SidebarToggle
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
    </div>
  );
}

export default function AppV2() {
  const { authReady, client } = useHitchServer();
  if (!authReady) return null;
  if (!client) return <SignInScreen />;
  return <WorkspaceV2 client={client} />;
}
