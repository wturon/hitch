"use client";

import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUp,
  ArrowUpRight,
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  EllipsisIcon,
  GaugeIcon,
  LoaderCircle,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import {
  HARNESSES,
  MODELS_BY_HARNESS,
  defaultEnvironment,
  defaultModel,
  defaultReasoning,
  environmentLabel,
  harnessLabel,
  honorsLaunchParams,
  isEnvironment,
  modelLabel,
  reasoningLabel,
  reasoningOptions,
  type Environment,
  type Harness,
} from "@/lib/chat";
import { useChatActions, useChatsHistory, useChatsHome } from "@/hooks/useChats";
import type { ChatRowViewModel } from "@/lib/chats";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

// Relative "last activity" stamp for chat rows. Recent (sub-hour) activity reads
// bare ("2m") so a live chat feels current; older activity trails "ago". Mirrors
// the Notes index stamp but with the chat designs' thresholds (days run to 13
// before flipping to weeks, so "9d ago" stays days, "2w ago" is the first week).
function relativeChatTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < min) return "now";
  if (diff < hour) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 14 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 8 * week) return `${Math.floor(diff / week)}w ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// The harness brand mark in a soft rounded tile — the row's leading slot. The
// brand-colored SVG (terracotta Claude Code / blue Codex) is the only color on
// the row; everything else is monochrome (see the PRD's locked decisions).
function ChatHarnessAvatar({ harness }: { harness: Harness }) {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
      <HarnessIcon harness={harness} className="size-5" />
    </div>
  );
}

// `(● )state · time` — the amber dot appears only while running (working), the
// one sanctioned color accent. Everything else stays muted/monochrome.
function ChatStatusLine({
  chat,
  archived,
}: {
  chat: ChatRowViewModel;
  archived?: boolean;
}) {
  const label = archived ? "archived" : chat.statusLabel;
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      {!archived && chat.running && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-[#F59E0B]"
          aria-hidden
        />
      )}
      <span className="truncate">
        {label} · {relativeChatTime(chat.sortTime)}
      </span>
    </span>
  );
}

// One chat row: a bordered card whose whole surface resumes the chat (opens out
// to the harness). On hover/focus it fills light-gray and reveals plain
// "Resume ↗" text — no button border, since the row itself is the target. A
// pending chat (just started, not yet bound to a real session) can't resume yet,
// so its row is inert until the daemon binds it.
function ChatRow({
  chat,
  archived,
  onResume,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  chat: ChatRowViewModel;
  archived?: boolean;
  onResume: (chat: ChatRowViewModel) => void;
  onPin: (chat: ChatRowViewModel) => void;
  onUnpin: (chat: ChatRowViewModel) => void;
  onArchive: (chat: ChatRowViewModel) => void;
  onUnarchive: (chat: ChatRowViewModel) => void;
  onDelete: (chat: ChatRowViewModel) => void;
}) {
  const resumable = !chat.pending && chat.resumeKind === "open-chat-command";

  function resume() {
    if (resumable) onResume(chat);
  }

  const togglePin = () => (chat.pinned ? onUnpin(chat) : onPin(chat));
  const toggleArchive = () =>
    chat.archived ? onUnarchive(chat) : onArchive(chat);
  const runMenuAction = (event: MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        <div
          role="button"
          tabIndex={resumable ? 0 : -1}
          aria-label={`Resume ${chat.title}`}
          onClick={resume}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            const target = e.target as HTMLElement | null;
            if (target?.closest("[data-chat-row-actions]")) return;
            e.preventDefault();
            resume();
          }}
          className={cn(
            "group flex items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3 transition-colors",
            resumable && "cursor-pointer hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            archived && "opacity-55 hover:opacity-100",
          )}
        >
          <ChatHarnessAvatar harness={chat.harness} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              {chat.title}
            </span>
            <ChatStatusLine chat={chat} archived={archived} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {resumable && (
              <span className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                Resume
                <ArrowUpRight className="size-3.5" />
              </span>
            )}
            {chat.pinned && !archived && (
              <PinIcon className="size-3.5 text-muted-foreground" aria-label="Pinned" />
            )}
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Actions for ${chat.title}`}
                    data-chat-row-actions
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                  />
                }
              >
                <EllipsisIcon className="size-4" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem
                  disabled={!resumable}
                  onClick={(event) => runMenuAction(event, resume)}
                >
                  <SquareTerminalIcon />
                  Resume chat
                  <CornerDownLeftIcon className="ml-auto size-3.5 text-muted-foreground" />
                </MenuItem>
                <MenuItem onClick={(event) => runMenuAction(event, togglePin)}>
                  {chat.pinned ? <PinOffIcon /> : <PinIcon />}
                  {chat.pinned ? "Unpin chat" : "Pin chat"}
                </MenuItem>
                <div className="my-1 h-px bg-border" />
                <MenuItem onClick={(event) => runMenuAction(event, toggleArchive)}>
                  {chat.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {chat.archived ? "Unarchive" : "Archive"}
                </MenuItem>
                <MenuItem
                  onClick={(event) => runMenuAction(event, () => onDelete(chat))}
                  className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
                >
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!resumable}
          onClick={(event) => runMenuAction(event, resume)}
        >
          <SquareTerminalIcon />
          Resume chat
          <CornerDownLeftIcon className="ml-auto size-3.5 text-muted-foreground" />
        </ContextMenuItem>
        <ContextMenuItem onClick={(event) => runMenuAction(event, togglePin)}>
          {chat.pinned ? <PinOffIcon /> : <PinIcon />}
          {chat.pinned ? "Unpin chat" : "Pin chat"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={(event) => runMenuAction(event, toggleArchive)}>
          {chat.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {chat.archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onClick={(event) => runMenuAction(event, () => onDelete(chat))}
        >
          <Trash2Icon />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// The "Start a chat" composer — a freeform prompt box with a harness/model and
// effort picker and a Send button. Reuses the delegate-to-agent control logic
// from the task dialog's DelegationBand, minus the preset row and (per the PRD)
// any link control: chats started here are always standalone.
function ChatComposer({
  onStart,
  onManageHarnesses,
  wide,
}: {
  onStart: (params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) => Promise<void> | void;
  onManageHarnesses?: () => void;
  wide?: boolean;
}) {
  const [harness, setHarness] = useState<Harness>("codex");
  const [model, setModel] = useState(() => defaultModel("codex"));
  const [effort, setEffort] = useState(() =>
    defaultReasoning("codex", defaultModel("codex")),
  );
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  // Per-harness run environment, read from the local daemon bridge. Claude in an
  // editor extension can't take model/effort at launch, so those controls are
  // disabled for that case (same rule the DelegationBand follows).
  const [harnessEnvs, setHarnessEnvs] = useState<Record<string, string>>({});

  useEffect(() => {
    const bridge =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              hitchDaemon?: {
                getHarnessEnvironments?: () => Promise<Record<string, string>>;
              };
            }
          ).hitchDaemon
        : undefined;
    if (!bridge?.getHarnessEnvironments) return;
    void bridge
      .getHarnessEnvironments()
      .then((map) => setHarnessEnvs(map ?? {}))
      .catch(() => {});
  }, []);

  // The combined agent dropdown picks a (harness, model) pair at once; switching
  // either resets reasoning to that model's default (Codex exposes effort as
  // model capability metadata).
  function chooseAgent(value: string) {
    const sep = value.indexOf("|");
    const nextHarness = value.slice(0, sep) as Harness;
    const nextModel = value.slice(sep + 1);
    setModel(nextModel);
    if (nextHarness !== harness) setHarness(nextHarness);
    if (nextHarness !== harness || nextModel !== model) {
      setEffort(defaultReasoning(nextHarness, nextModel));
    }
  }

  async function start() {
    const trimmed = prompt.trim();
    if (!trimmed || starting) return;
    setStarting(true);
    try {
      await onStart({ harness, model, effort, prompt: trimmed });
      setPrompt("");
    } finally {
      // The daemon spawn is async; brief busy state mirrors the DelegationBand.
      setTimeout(() => setStarting(false), 600);
    }
  }

  const storedEnv = harnessEnvs[harness];
  const currentEnv: Environment = isEnvironment(storedEnv ?? "")
    ? (storedEnv as Environment)
    : defaultEnvironment(harness);
  const paramsHonored = honorsLaunchParams(harness, currentEnv);

  // Ghost-styled, borderless triggers so the pickers read as inline chips.
  const chipTrigger = "h-7 gap-1.5 border-0 px-2 font-normal hover:bg-muted";

  return (
    <div className={cn("mx-auto w-full", wide ? "max-w-[760px]" : "max-w-[720px]")}>
      <label
        htmlFor="chat-composer-input"
        className="mb-2 block text-sm font-semibold text-foreground"
      >
        Start a chat
      </label>
      <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <textarea
          id="chat-composer-input"
          aria-label="Start a chat"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter (and ⌘/Ctrl+Enter) keep a newline-friendly
            // path. A chat composer reads as "type and send".
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          placeholder="What are we working on?"
          spellCheck={false}
          rows={3}
          autoFocus
          className="block w-full resize-none bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2 border-t border-border py-2 pr-2 pl-2.5">
          <div className="flex min-w-0 items-center gap-1">
            {/* Combined harness + model picker: models grouped under their
                harness, so choosing a model also fixes the harness. */}
            <Select
              value={`${harness}|${model}`}
              onValueChange={(value) => chooseAgent(value as string)}
            >
              <SelectTrigger aria-label="Agent and model" className={chipTrigger}>
                <SelectValue>
                  {(value: string) => {
                    const sep = value.indexOf("|");
                    const h = value.slice(0, sep) as Harness;
                    const m = value.slice(sep + 1);
                    return (
                      <span className="flex items-center gap-1.5">
                        <HarnessIcon harness={h} className="size-4" />
                        <span className="font-medium">{harnessLabel(h)}</span>
                        <span className="text-muted-foreground">
                          {modelLabel(h, m)}
                        </span>
                      </span>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HARNESSES.map((h) => (
                  <Fragment key={h}>
                    <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                      <HarnessIcon harness={h} className="size-3.5" />
                      {harnessLabel(h)}
                    </div>
                    {MODELS_BY_HARNESS[h].map((m) => (
                      <SelectItem
                        key={`${h}|${m.id}`}
                        value={`${h}|${m.id}`}
                        className="pl-7"
                      >
                        {m.label}
                      </SelectItem>
                    ))}
                  </Fragment>
                ))}
              </SelectContent>
            </Select>

            <span className="h-4 w-px shrink-0 bg-border" aria-hidden />

            {/* Reasoning/effort — harness-specific; disabled when the chosen
                harness/environment can't accept it at launch. */}
            <Select
              value={effort}
              onValueChange={(value) => setEffort(value as string)}
              disabled={!paramsHonored}
            >
              <SelectTrigger aria-label="Reasoning effort" className={chipTrigger}>
                <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue>
                  {(value: string) => reasoningLabel(harness, value, model)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {reasoningOptions(harness, model).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Send — the primary one-click trigger. Black rounded square, up
              arrow, no text. */}
          <Button
            onClick={() => void start()}
            disabled={starting || prompt.trim() === ""}
            aria-label="Start chat"
            className="size-8 shrink-0 rounded-lg p-0"
          >
            {starting ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <ArrowUp className="size-4" strokeWidth={2.5} />
            )}
          </Button>
        </div>

        {!paramsHonored && (
          <p className="border-t border-border bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400/90">
            For Claude Code in {environmentLabel(currentEnv)}, model and reasoning
            are set in the editor window.{" "}
            {onManageHarnesses && (
              <button
                type="button"
                onClick={onManageHarnesses}
                className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
              >
                Manage your preferred harness environments here
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

// A list section: a small header (label + optional leading icon + optional
// right-side slot) above its rows.
function ChatSection({
  label,
  icon,
  meta,
  right,
  dimmed,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  // Inline note beside the label (e.g. the Recent header's "N running" count).
  meta?: React.ReactNode;
  right?: React.ReactNode;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <h2
            className={cn(
              "flex items-center gap-1.5 text-sm font-semibold",
              dimmed ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {icon}
            {label}
          </h2>
          {meta}
        </div>
        {right}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

// The Chats tab. Two screens behind one tab: the merged Home (composer + Pinned
// + Recent) and a drilled-in View all (search + Pinned/All/Archived), reached
// from Home's "View all" and returned via a contextual "‹ Chats" back-bar —
// the same drill-in shape as the Notes editor.
export function ChatsView({
  projectId,
  onManageHarnesses,
  onExit,
}: {
  projectId: Id<"projects">;
  onManageHarnesses?: () => void;
  onExit: () => void;
}) {
  const [mode, setMode] = useState<"home" | "all">("home");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const actions = useChatActions();
  const home = useChatsHome(projectId, { recentLimit: 6 });
  const history = useChatsHistory(projectId, {
    search: mode === "all" ? query : undefined,
  });

  // Resume opens the chat out in the harness (cmux). The mutation enqueues an
  // open-chat command for the local daemon; it throws for a chat that isn't
  // ready (still pending) — caught here so a stray click never surfaces an error.
  function resumeChat(chat: ChatRowViewModel) {
    void Promise.resolve(actions.resumeChat({ projectId, id: chat.id })).catch(
      () => {},
    );
  }

  const rowHandlers = {
    onResume: resumeChat,
    onPin: (chat: ChatRowViewModel) =>
      void actions.pinChat({ projectId, id: chat.id }),
    onUnpin: (chat: ChatRowViewModel) =>
      void actions.unpinChat({ projectId, id: chat.id }),
    onArchive: (chat: ChatRowViewModel) =>
      void actions.archiveChat({ projectId, id: chat.id }),
    onUnarchive: (chat: ChatRowViewModel) =>
      void actions.unarchiveChat({ projectId, id: chat.id }),
    onDelete: (chat: ChatRowViewModel) =>
      void actions.deleteChat({ projectId, id: chat.id }),
  };

  async function startChat(params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) {
    // Standalone start — no linkedType/linkedPath. The daemon resolves the
    // project's local cwd from the launch command.
    await actions.startChat({
      projectId,
      harness: params.harness,
      initialPrompt: params.prompt,
      model: params.model,
      effort: params.effort,
    });
  }

  // Focus the search field when entering View all; Esc there clears the query,
  // then a second Esc returns to Home (the drill-in's back path).
  useEffect(() => {
    if (mode === "all") searchRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== "all") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      e.preventDefault();
      if (query) {
        setQuery("");
      } else {
        setMode("home");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, query]);

  // Esc from the Chats home steps back to Notes. The View all drill-in keeps its
  // own Esc behavior above (clear search, then return home), so the workspace
  // ladder remains Chats → Notes → Board.
  useEffect(() => {
    if (mode !== "home") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      e.preventDefault();
      onExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onExit]);

  const composer = (
    <ChatComposer onStart={startChat} onManageHarnesses={onManageHarnesses} />
  );

  // Empty / first run: just the centered composer (slightly wider), no list.
  if (mode === "home" && home.data?.kind === "empty") {
    return (
      <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto sm:-mx-6 lg:-mx-8">
        <div className="flex min-h-full flex-1 items-center justify-center px-6 py-10">
          <ChatComposer
            onStart={startChat}
            onManageHarnesses={onManageHarnesses}
            wide
          />
        </div>
      </div>
    );
  }

  if (mode === "all") {
    const data = history.data;
    return (
      <div className="-mx-4 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8">
        {/* Contextual back-bar — replaces the tab strip for the drill-in. */}
        <div className="flex h-12 shrink-0 items-center px-6">
          <button
            type="button"
            onClick={() => setMode("home")}
            aria-label="Back to chats"
            className="flex items-center gap-1 rounded-lg py-1 pr-2.5 pl-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeftIcon className="size-4" />
            Chats
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-6 pt-4 pb-12">
            {/* Notes-style search bar. */}
            <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-3.5 focus-within:ring-2 focus-within:ring-ring">
              <SearchIcon className="size-[18px] shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats…"
                spellCheck={false}
                className="h-11 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>

            {data && (
              <>
                {data.pinned.length > 0 && (
                  <ChatSection
                    label="Pinned"
                    icon={<PinIcon className="size-3.5 text-muted-foreground" />}
                  >
                    {data.pinned.map((chat) => (
                      <ChatRow key={chat.id} chat={chat} {...rowHandlers} />
                    ))}
                  </ChatSection>
                )}

                <ChatSection label="All">
                  {data.all.length === 0 && data.pinned.length === 0 ? (
                    <p className="px-1 text-sm text-muted-foreground">
                      {query
                        ? "No chats match your search."
                        : "No chats yet."}
                    </p>
                  ) : (
                    data.all.map((chat) => (
                      <ChatRow key={chat.id} chat={chat} {...rowHandlers} />
                    ))
                  )}
                </ChatSection>

                {data.archived.length > 0 && (
                  <ChatSection
                    label="Archived"
                    dimmed
                    icon={
                      <ArchiveIcon className="size-3.5 text-muted-foreground" />
                    }
                  >
                    {data.archived.map((chat) => (
                      <ChatRow
                        key={chat.id}
                        chat={chat}
                        archived
                        {...rowHandlers}
                      />
                    ))}
                  </ChatSection>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Home (merged): composer, then Pinned and Recent.
  const data = home.data;
  return (
    <div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-y-auto sm:-mx-6 lg:-mx-8">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-6 pt-10 pb-12">
        {composer}

        {data && data.pinned.length > 0 && (
          <ChatSection
            label="Pinned"
            icon={<PinIcon className="size-3.5 text-muted-foreground" />}
          >
            {data.pinned.map((chat) => (
              <ChatRow key={chat.id} chat={chat} {...rowHandlers} />
            ))}
          </ChatSection>
        )}

        {data && data.recent.length > 0 && (
          <ChatSection
            label="Recent"
            meta={
              data.runningCount > 0 && (
                <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                  <span
                    className="size-1.5 rounded-full bg-[#F59E0B]"
                    aria-hidden
                  />
                  {data.runningCount} running
                </span>
              )
            }
            right={
              <button
                type="button"
                onClick={() => setMode("all")}
                className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
              >
                View all
                <span className="text-muted-foreground/70">
                  {data.totalVisible}
                </span>
                <ChevronRightIcon className="size-3.5" />
              </button>
            }
          >
            {data.recent.map((chat) => (
              <ChatRow key={chat.id} chat={chat} {...rowHandlers} />
            ))}
          </ChatSection>
        )}
      </div>
    </div>
  );
}
