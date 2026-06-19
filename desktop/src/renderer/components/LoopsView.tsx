"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronLeftIcon,
  CodeXmlIcon,
  EllipsisIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import { setFrontmatterKeys, splitFrontmatter } from "@/lib/frontmatter";
import { uniqueSlug } from "@/lib/tasks";
import {
  type LoopDoc,
  loopBodyPath,
  loopDocs,
  loopTriggerPath,
  cronNextRun,
  cycleProgress,
  humanizeCron,
  ringCountdown,
} from "@/lib/loops";
import {
  type Harness,
  type ChatRef,
  HARNESSES,
  MODELS_BY_HARNESS,
  reasoningOptions,
  defaultModel,
  defaultReasoning,
  modelLabel,
  reasoningLabel,
} from "@/lib/chat";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/MarkdownEditor";
import { HarnessChip } from "@/components/HarnessChip";
import { HarnessIcon } from "@/components/HarnessIcon";
import { TriggerScriptModal } from "@/components/TriggerScriptModal";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useLoopLocalState } from "@/hooks/useLoopLocalState";
import { cn } from "@/lib/utils";

type LoopRun = Doc<"loopRuns">;

// A one-shot request from the command palette to open or create a loop.
export type LoopIntent =
  | { type: "open"; slug: string }
  | { type: "create"; title: string };

interface FileDoc {
  _id: Id<"files">;
  path: string;
  content: string;
  deleted: boolean;
  updatedAt: number;
}

type SubTab = "automations" | "activity";

// The schedule presets offered in the legend dropdown. The stored value is a
// standard 5-field cron; "Custom" reveals a raw-cron input for anything else.
const SCHEDULE_PRESETS: { cron: string; label: string }[] = [
  { cron: "*/5 * * * *", label: "every 5 minutes" },
  { cron: "*/15 * * * *", label: "every 15 minutes" },
  { cron: "*/30 * * * *", label: "every 30 minutes" },
  { cron: "0 * * * *", label: "hourly" },
  { cron: "0 8 * * *", label: "daily at 8am" },
  { cron: "30 8 * * 1-5", label: "weekdays at 8:30am" },
  { cron: "0 9 * * 1", label: "Mondays at 9am" },
];

const DEFAULT_SCHEDULE = "*/30 * * * *";

export function LoopsView({
  projectId,
  projectCwd,
  files,
  intent,
  onIntentHandled,
}: {
  projectId: Id<"projects">;
  // The project's local absolute path, so "Open chat" can resume a Claude
  // session (claude --resume needs the original cwd). Undefined → chip still
  // renders but resume may fall back.
  projectCwd?: string;
  files: FileDoc[];
  intent: LoopIntent | null;
  onIntentHandled: () => void;
}) {
  const upsertFile = useMutation(api.files.upsertFile).withOptimisticUpdate(
    (localStore, args) => {
      const existing = localStore.getQuery(api.files.listFiles, {
        projectId: args.projectId,
      });
      if (existing === undefined) return;
      type QDoc = (typeof existing)[number];
      const idx = existing.findIndex((f) => f.path === args.path);
      const base: QDoc =
        idx >= 0
          ? existing[idx]
          : ({
              _id: `optimistic:${args.path}` as QDoc["_id"],
              _creationTime: Number.MAX_SAFE_INTEGER,
              projectId: "" as QDoc["projectId"],
              path: args.path,
              content: "",
              hash: "",
              deleted: false,
              updatedAt: Number.MAX_SAFE_INTEGER,
            } satisfies QDoc);
      const patched: QDoc = {
        ...base,
        content: args.content,
        hash: args.hash,
        deleted: args.deleted,
        updatedAt: Number.MAX_SAFE_INTEGER,
      };
      const next =
        idx >= 0
          ? existing.map((f, i) => (i === idx ? patched : f))
          : [...existing, patched];
      localStore.setQuery(api.files.listFiles, { projectId: args.projectId }, next);
    },
  );
  const runs = useQuery(api.loops.listRunsByProject, { projectId }) ?? [];
  const local = useLoopLocalState(projectId);

  const [tab, setTab] = useState<SubTab>("automations");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [runSheet, setRunSheet] = useState<LoopRun | null>(null);

  const docs = useMemo(() => loopDocs(files), [files]);
  const sorted = useMemo(
    () => [...docs].sort((a, b) => b.updatedAt - a.updatedAt),
    [docs],
  );
  const selected = selectedSlug
    ? (docs.find((d) => d.slug === selectedSlug) ?? null)
    : null;

  // Newest run per loop path (runs come back newest-first).
  const latestByLoop = useMemo(() => {
    const map = new Map<string, LoopRun>();
    for (const run of runs) if (!map.has(run.loopPath)) map.set(run.loopPath, run);
    return map;
  }, [runs]);

  // Fall back to the index if the open loop disappears (deleted here/remotely).
  useEffect(() => {
    if (selectedSlug === null) return;
    if (!docs.some((d) => d.slug === selectedSlug)) setSelectedSlug(null);
  }, [docs, selectedSlug]);

  async function persist(path: string, content: string) {
    await upsertFile({
      projectId,
      path,
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  // Create a loop from the index (title pre-filled or blank) and open it. The
  // slug is derived from the title (uniqued). A loop with no prompt is harmless —
  // it just won't have been enabled — so we don't auto-discard like notes.
  async function createLoop(title: string) {
    const taken = new Set(docs.map((d) => d.slug));
    const slug = uniqueSlug(title, taken, "loop");
    const content = setFrontmatterKeys("", {
      title: title || undefined,
      schedule: `"${DEFAULT_SCHEDULE}"`,
      harness: "claude-code",
      model: defaultModel("claude-code"),
      reasoning: defaultReasoning("claude-code"),
      timeoutMinutes: "20",
      concurrency: "skip",
    });
    // Apply the optimistic write (await the hash first) BEFORE selecting, so the
    // new loop is already in `docs` when `selectedSlug` flips — otherwise the
    // fall-back-to-index effect would clear the selection before it arrives.
    const hash = await sha256(content);
    void upsertFile({
      projectId,
      path: loopBodyPath(slug),
      content,
      hash,
      deleted: false,
    });
    setSelectedSlug(slug);
    setTab("automations");
  }

  async function deleteLoop(slug: string) {
    // Tombstone the definition and any trigger script.
    await upsertFile({
      projectId,
      path: loopBodyPath(slug),
      content: "",
      hash: "",
      deleted: true,
    });
    const trigger = files.find(
      (f) => f.path === loopTriggerPath(slug) && !f.deleted,
    );
    if (trigger) {
      await upsertFile({
        projectId,
        path: loopTriggerPath(slug),
        content: "",
        hash: "",
        deleted: true,
      });
    }
    if (selectedSlug === slug) setSelectedSlug(null);
  }

  // Tombstone a loop's trigger.sh (used by the trigger modal's Remove).
  async function removeTrigger(scriptPath: string) {
    await upsertFile({
      projectId,
      path: scriptPath,
      content: "",
      hash: "",
      deleted: true,
    });
  }

  // Run "now" via the command bus (kind: loop-run, targeted at the local host).
  const enqueueCommand = useMutation(api.commands.enqueueCommand);
  async function runNow(doc: LoopDoc) {
    await enqueueCommand({
      projectId,
      kind: "loop-run",
      harness: doc.harness,
      loopPath: doc.loopPath,
      cwd: projectCwd,
    });
  }

  // Consume a one-shot palette request.
  useEffect(() => {
    if (!intent) return;
    if (intent.type === "open") {
      setTab("automations");
      setSelectedSlug(intent.slug);
    } else {
      void createLoop(intent.title);
    }
    onIntentHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  return (
    <div className="-mx-4 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8">
      {selected ? (
        <LoopDetail
          key={selected.slug}
          projectId={projectId}
          projectCwd={projectCwd}
          doc={selected}
          runs={runs.filter((r) => r.loopPath === selected.loopPath)}
          enabled={local.stateFor(selected.loopPath).enabled}
          trusted={local.stateFor(selected.loopPath).trusted}
          onSetEnabled={(v) => void local.setEnabled(selected.loopPath, v)}
          onSetTrust={(scriptPath, hash) =>
            void local.setTrust(selected.loopPath, scriptPath, hash)
          }
          onClearTrust={(scriptPath) =>
            void local.clearTrust(selected.loopPath, scriptPath)
          }
          onSave={persist}
          onRemoveTrigger={removeTrigger}
          onRunNow={() => void runNow(selected)}
          onOpenRun={setRunSheet}
          onBack={() => setSelectedSlug(null)}
          files={files}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 pt-7 pb-10">
            <SubTabs
              tab={tab}
              onTab={setTab}
              count={docs.length}
            />
            {tab === "automations" ? (
              <LoopsIndex
                docs={sorted}
                latestByLoop={latestByLoop}
                enabledFor={(p) => local.stateFor(p).enabled}
                onOpen={(slug) => setSelectedSlug(slug)}
                onCreate={(title) => void createLoop(title)}
                onRunNow={(doc) => void runNow(doc)}
                onToggleEnabled={(doc, v) =>
                  void local.setEnabled(doc.loopPath, v)
                }
                onDelete={(doc) => void deleteLoop(doc.slug)}
              />
            ) : (
              <ActivityView
                projectId={projectId}
                projectCwd={projectCwd}
                runs={runs}
                docs={docs}
                onOpenRun={setRunSheet}
              />
            )}
          </div>
        </div>
      )}

      <RunDetailSheet
        projectId={projectId}
        projectCwd={projectCwd}
        run={runSheet}
        docs={docs}
        onOpenChange={(open) => {
          if (!open) setRunSheet(null);
        }}
      />
    </div>
  );
}

// ───────────────────────────── sub-tabs (Automations / Activity) ────────────

function SubTabs({
  tab,
  onTab,
  count,
}: {
  tab: SubTab;
  onTab: (t: SubTab) => void;
  count: number;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 pb-3.5">
        <button
          type="button"
          onClick={() => onTab("automations")}
          className={cn(
            "inline-flex h-[30px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition-colors",
            tab === "automations"
              ? "border-[0.75px] border-border bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Automations
          <span className="font-mono text-[11px] text-muted-foreground">
            {count}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onTab("activity")}
          className={cn(
            "inline-flex h-[30px] items-center rounded-lg px-2.5 text-sm font-medium transition-colors",
            tab === "activity"
              ? "border-[0.75px] border-border bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Activity
        </button>
      </div>
      <div className="h-px bg-border" />
    </div>
  );
}

// ───────────────────────────── ring ─────────────────────────────────────────

const RING_CIRCUMFERENCE = 2 * Math.PI * 20; // r=20

// The circular progress ring with the next-run countdown at its center. A paused
// (disabled) loop shows an empty grey ring with no text.
function LoopRing({
  schedule,
  next,
  now,
  paused,
  size = 46,
}: {
  schedule: string;
  next: Date | null;
  now: Date;
  paused: boolean;
  size?: number;
}) {
  const progress = paused ? 0 : cycleProgress(schedule, next, now);
  const dash = progress * RING_CIRCUMFERENCE;
  const label = paused ? "" : ringCountdown(next, now);
  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 46 46"
        className="absolute inset-0"
      >
        <circle
          cx="23"
          cy="23"
          r="20"
          fill="none"
          stroke="currentColor"
          className="text-border"
          strokeWidth="3.5"
        />
        {!paused && (
          <circle
            cx="23"
            cy="23"
            r="20"
            transform="rotate(-90 23 23)"
            fill="none"
            stroke="currentColor"
            className="text-foreground"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          />
        )}
      </svg>
      {label && (
        <span className="relative font-mono text-[11px] font-medium tracking-tight text-foreground">
          {label}
        </span>
      )}
    </div>
  );
}

// ───────────────────────────── run formatting ───────────────────────────────

// The minimal surfaced state (Running / Ran / Skipped) for a run record. The
// record keeps richer detail (trigger-error / launch-error / timed-out /
// interrupted), but the UI stays minimal per the design.
function surfacedStatus(status: string): "Running" | "Ran" | "Skipped" {
  if (status === "running") return "Running";
  if (status === "skipped" || status === "trigger-error") return "Skipped";
  return "Ran";
}

function runSummaryText(run: LoopRun): string {
  if (run.summary) return run.summary;
  const s = surfacedStatus(run.status);
  if (s === "Running") return "running…";
  if (s === "Skipped") {
    if (run.triggerExitCode != null && run.triggerExitCode !== 0)
      return `trigger exited ${run.triggerExitCode}`;
    return "skipped";
  }
  return "ran";
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${String(sec % 60).padStart(2, "0")}s`;
}

function runDuration(run: LoopRun, now: number): string | null {
  if (run.status === "running") return formatDuration(now - run.startedAt);
  if (run.durationMs != null) return formatDuration(run.durationMs);
  if (run.finishedAt != null) return formatDuration(run.finishedAt - run.startedAt);
  return null;
}

// Relative stamp for the index card meta line ("ran 12m ago" / "skipped 3h ago").
function relativeRan(run: LoopRun | undefined): string | null {
  if (!run) return null;
  const verb = surfacedStatus(run.status).toLowerCase();
  const ts = run.finishedAt ?? run.startedAt;
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  let rel: string;
  if (diff < min) rel = "just now";
  else if (diff < hour) rel = `${Math.floor(diff / min)}m ago`;
  else if (diff < day) rel = `${Math.floor(diff / hour)}h ago`;
  else rel = `${Math.floor(diff / day)}d ago`;
  return run.status === "running" ? "running now" : `${verb} ${rel}`;
}

function chatRefFor(run: LoopRun, cwd?: string): ChatRef | null {
  if (!run.sessionId) return null;
  return {
    harness: run.harness === "codex" ? "codex" : "claude-code",
    id: run.sessionId,
    cwd,
  };
}

// A 1-second clock for live countdowns / durations. Shared so the whole view
// re-renders in step.
function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// ───────────────────────────── index (ring cards) ───────────────────────────

type IndexItem =
  | { kind: "loop"; doc: LoopDoc }
  | { kind: "create"; title: string };

function rankLoops(docs: LoopDoc[], query: string): LoopDoc[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  const scored: { doc: LoopDoc; score: number }[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 2;
    else if (title.includes(q)) score = 1;
    else if (doc.prompt.toLowerCase().includes(q)) score = 0;
    if (score >= 0) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt);
  return scored.map((s) => s.doc);
}

function LoopsIndex({
  docs,
  latestByLoop,
  enabledFor,
  onOpen,
  onCreate,
  onRunNow,
  onToggleEnabled,
  onDelete,
}: {
  docs: LoopDoc[];
  latestByLoop: Map<string, LoopRun>;
  enabledFor: (loopPath: string) => boolean;
  onOpen: (slug: string) => void;
  onCreate: (title: string) => void;
  onRunNow: (doc: LoopDoc) => void;
  onToggleEnabled: (doc: LoopDoc, enabled: boolean) => void;
  onDelete: (doc: LoopDoc) => void;
}) {
  const [query, setQuery] = useState("");
  const now = useNow(true);
  const results = useMemo(() => rankLoops(docs, query), [docs, query]);
  const items = useMemo<IndexItem[]>(() => {
    const list: IndexItem[] = results.map((doc) => ({ kind: "loop", doc }));
    list.push({ kind: "create", title: query.trim() });
    return list;
  }, [results, query]);

  return (
    <div className="flex flex-col pt-5.5">
      <div className="flex items-center gap-2.75 rounded-xl border border-border bg-background px-4 py-3 shadow-[0_0_0_4px_rgba(24,24,27,0.06)] focus-within:border-muted-foreground/40">
        <SearchIcon className="size-[18px] shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (results[0]) onOpen(results[0].slug);
              else onCreate(query.trim());
            }
          }}
          placeholder="Search loops, or type to create…"
          spellCheck={false}
          className="h-5 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex flex-col gap-2 pt-2">
        {items.map((item) =>
          item.kind === "loop" ? (
            <LoopCard
              key={item.doc.slug}
              doc={item.doc}
              latestRun={latestByLoop.get(item.doc.loopPath)}
              enabled={enabledFor(item.doc.loopPath)}
              now={now}
              onOpen={() => onOpen(item.doc.slug)}
              onRunNow={() => onRunNow(item.doc)}
              onToggleEnabled={(v) => onToggleEnabled(item.doc, v)}
              onDelete={() => onDelete(item.doc)}
            />
          ) : (
            <button
              key="__create"
              type="button"
              onClick={() => onCreate(item.title)}
              className="flex items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left hover:bg-muted"
            >
              <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
              {item.title ? (
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-[15px] text-muted-foreground">Create</span>
                  <span className="truncate text-[15px] font-medium text-foreground">
                    “{item.title}”
                  </span>
                </span>
              ) : (
                <span className="text-[15px] text-muted-foreground">New loop</span>
              )}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function LoopCard({
  doc,
  latestRun,
  enabled,
  now,
  onOpen,
  onRunNow,
  onToggleEnabled,
  onDelete,
}: {
  doc: LoopDoc;
  latestRun: LoopRun | undefined;
  enabled: boolean;
  now: Date;
  onOpen: () => void;
  onRunNow: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const next = useMemo(
    () => (enabled ? cronNextRun(doc.schedule, now) : null),
    [doc.schedule, enabled, now],
  );
  const ran = relativeRan(latestRun);
  return (
    <div
      onClick={onOpen}
      className={cn(
        "flex cursor-pointer items-center gap-4 rounded-xl border-[0.75px] border-border bg-background p-4 shadow-[0_1px_1px_rgba(0,0,0,0.024)] transition-colors hover:border-muted-foreground/30",
        !enabled && "opacity-[0.55]",
      )}
    >
      <LoopRing schedule={doc.schedule} next={next} now={now} paused={!enabled} />
      <div className="flex min-w-0 grow flex-col gap-1">
        <span className="truncate text-base font-semibold tracking-tight text-foreground">
          {doc.title}
        </span>
        <div className="flex items-center gap-1.75">
          <span className="font-mono text-xs text-foreground/70">
            {humanizeCron(doc.schedule)}
          </span>
          {ran && (
            <>
              <span className="text-xs text-muted-foreground/50">·</span>
              <span className="text-[13px] text-muted-foreground">{ran}</span>
            </>
          )}
        </div>
      </div>
      <div className="self-start" onClick={(e) => e.stopPropagation()}>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Actions for ${doc.title}`}
                className="flex size-6.5 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
              />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onClick={onRunNow}>
              <PlayIcon />
              Run now
            </MenuItem>
            <MenuItem onClick={() => onToggleEnabled(!enabled)}>
              <RefreshCwIcon />
              {enabled ? "Disable" : "Enable"}
            </MenuItem>
            <MenuItem onClick={onOpen}>
              <CodeXmlIcon />
              Open detail
            </MenuItem>
            <div className="my-1 h-px bg-border" />
            <MenuItem
              onClick={onDelete}
              className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
            >
              <Trash2Icon />
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

// ───────────────────────────── activity (global run log) ────────────────────

function ActivityView({
  projectId,
  projectCwd,
  runs,
  docs,
  onOpenRun,
}: {
  projectId: Id<"projects">;
  projectCwd?: string;
  runs: LoopRun[];
  docs: LoopDoc[];
  onOpenRun: (run: LoopRun) => void;
}) {
  const now = useNow(runs.some((r) => r.status === "running"));
  const titleFor = (loopPath: string) =>
    docs.find((d) => d.loopPath === loopPath)?.title ??
    loopPath.replace(/^loops\//, "");

  if (runs.length === 0) {
    return (
      <div className="pt-12 text-center text-[15px] text-muted-foreground">
        No runs yet. Enable a loop or Run once to see activity here.
      </div>
    );
  }

  return (
    <div className="flex flex-col pt-3">
      {runs.map((run) => {
        const chat = chatRefFor(run, projectCwd);
        const dur = runDuration(run, now.getTime());
        return (
          <button
            key={run._id}
            type="button"
            onClick={() => onOpenRun(run)}
            className="flex items-center gap-4 rounded-lg px-1 py-3 text-left transition-colors hover:bg-muted/60"
          >
            <span className="w-[120px] shrink-0 font-mono text-xs text-muted-foreground">
              {new Date(run.startedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                run.status === "running" ? "bg-[#EAB308]" : "bg-muted-foreground/30",
              )}
            />
            <span className="w-[180px] shrink-0 truncate text-sm font-medium text-foreground">
              {titleFor(run.loopPath)}
            </span>
            <span className="min-w-0 grow truncate text-sm text-muted-foreground">
              {surfacedStatus(run.status)} · {runSummaryText(run)}
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground/70">
              {dur ?? "–"}
            </span>
            <span className="w-[110px] shrink-0" onClick={(e) => e.stopPropagation()}>
              {chat && (
                <HarnessChip chat={chat} projectId={projectId} />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────────── detail (loop box) ────────────────────────────

function LoopDetail({
  projectId,
  projectCwd,
  doc,
  runs,
  enabled,
  trusted,
  onSetEnabled,
  onSetTrust,
  onClearTrust,
  onSave,
  onRemoveTrigger,
  onRunNow,
  onOpenRun,
  onBack,
  files,
}: {
  projectId: Id<"projects">;
  projectCwd?: string;
  doc: LoopDoc;
  runs: LoopRun[];
  enabled: boolean;
  trusted: Record<string, string>;
  onSetEnabled: (enabled: boolean) => void;
  onSetTrust: (scriptPath: string, hash: string) => void;
  onClearTrust: (scriptPath: string) => void;
  onSave: (path: string, content: string) => Promise<void>;
  onRemoveTrigger: (scriptPath: string) => Promise<void>;
  onRunNow: () => void;
  onOpenRun: (run: LoopRun) => void;
  onBack: () => void;
  files: FileDoc[];
}) {
  const now = useNow(true);
  const next = enabled ? cronNextRun(doc.schedule, now) : null;
  const [triggerOpen, setTriggerOpen] = useState(false);
  const promptRef = useRef<MarkdownEditorHandle>(null);

  // Edit the prompt body in place (recombine with verbatim frontmatter).
  function savePrompt(body: string) {
    const { frontmatterBlock } = splitFrontmatter(doc.content);
    void onSave(doc.path, frontmatterBlock + body);
  }

  function setSchedule(cron: string) {
    void onSave(doc.path, setFrontmatterKeys(doc.content, { schedule: `"${cron}"` }));
  }

  function setAgent(harness: Harness, model: string, reasoning: string) {
    void onSave(
      doc.path,
      setFrontmatterKeys(doc.content, { harness, model, reasoning }),
    );
  }

  const triggerFile = files.find(
    (f) => f.path === loopTriggerPath(doc.slug) && !f.deleted,
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* back-to-index header */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-background/80 px-6 py-3 backdrop-blur">
        <button
          type="button"
          aria-label="Back to loops"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[13px] font-medium text-foreground hover:bg-muted"
        >
          <ChevronLeftIcon className="size-4" />
          Loops
        </button>
        <EnableToggle enabled={enabled} onChange={onSetEnabled} />
      </div>

      <div className="mx-auto flex w-full max-w-[680px] flex-col px-6 pt-8 pb-16">
        <h1 className="text-[32px] font-bold tracking-tight text-foreground">
          {doc.title || "Untitled loop"}
        </h1>

        {/* the loop box */}
        <div className="relative mt-7 rounded-2xl border border-border p-4 pt-0">
          {/* legend cutting the top border */}
          <div className="-mt-3 mb-2 flex items-center justify-between">
            <ScheduleLegend schedule={doc.schedule} onChange={setSchedule} />
            <div className="flex items-center gap-2 bg-background pl-2">
              <LoopRing
                schedule={doc.schedule}
                next={next}
                now={now}
                paused={!enabled}
                size={22}
              />
              <span className="font-mono text-xs text-muted-foreground">
                {enabled ? `next run ${ringCountdown(next, now)}` : "paused"}
              </span>
            </div>
          </div>

          {/* trigger card */}
          <TriggerCard
            hasTrigger={doc.hasTrigger}
            trusted={!!triggerFile && trusted[triggerFile.path] !== undefined}
            onOpen={() => setTriggerOpen(true)}
          />

          {/* connector */}
          <div className="flex justify-center py-2 text-muted-foreground/50">
            ↓
          </div>

          {/* prompt card */}
          <div className="rounded-xl border border-border">
            <div className="px-4 py-3">
              <MarkdownEditor
                ref={promptRef}
                value={doc.prompt}
                onChange={savePrompt}
                placeholder="Describe what this loop should do each run…"
                className="min-h-[60px] text-[15px]"
              />
            </div>
            <div className="flex items-center gap-3 border-t border-border px-4 py-2.5">
              <AgentSelectors
                harness={doc.harness}
                model={doc.model ?? defaultModel(doc.harness)}
                reasoning={doc.reasoning ?? defaultReasoning(doc.harness)}
                onChange={setAgent}
              />
            </div>
          </div>
        </div>

        {/* run history */}
        <div className="mt-9 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Run history
            </span>
            <span className="font-mono text-xs text-muted-foreground/70">
              {runs.length === 0 ? "No runs yet" : `${runs.length} runs`}
            </span>
          </div>
          <button
            type="button"
            onClick={onRunNow}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted"
          >
            <PlayIcon className="size-3.5" />
            Run once
          </button>
        </div>

        <div className="mt-3 flex flex-col">
          {runs.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Runs will appear here once the loop is enabled and its schedule
              fires — or after you Run once.
            </p>
          ) : (
            runs.map((run) => (
              <RunHistoryRow
                key={run._id}
                run={run}
                projectId={projectId}
                projectCwd={projectCwd}
                now={now}
                onOpen={() => onOpenRun(run)}
              />
            ))
          )}
        </div>
      </div>

      <TriggerScriptModal
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        projectId={projectId}
        projectCwd={projectCwd}
        slug={doc.slug}
        scriptPath={loopTriggerPath(doc.slug)}
        content={triggerFile?.content ?? null}
        trustedHash={triggerFile ? trusted[triggerFile.path] : undefined}
        onSave={onSave}
        onTrust={onSetTrust}
        onClearTrust={onClearTrust}
        onRemove={onRemoveTrigger}
      />
    </div>
  );
}

function EnableToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground"
    >
      <span
        className={cn(
          "relative h-[18px] w-8 rounded-full transition-colors",
          enabled ? "bg-foreground" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-[14px] rounded-full bg-background transition-transform",
            enabled ? "translate-x-[15px]" : "translate-x-0.5",
          )}
        />
      </span>
      {enabled ? "Enabled" : "Disabled"}
    </button>
  );
}

function ScheduleLegend({
  schedule,
  onChange,
}: {
  schedule: string;
  onChange: (cron: string) => void;
}) {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === schedule);
  return (
    <div className="flex items-center gap-2 bg-background pr-2">
      <RefreshCwIcon className="size-3.5 text-muted-foreground" />
      <Select
        value={preset ? preset.cron : "__custom"}
        onValueChange={(v) => {
          if (typeof v === "string" && v !== "__custom") onChange(v);
        }}
      >
        <SelectTrigger className="h-7 gap-1 border-0 px-1 font-semibold hover:bg-muted">
          <SelectValue>
            {preset ? preset.label : humanizeCron(schedule)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SCHEDULE_PRESETS.map((p) => (
            <SelectItem key={p.cron} value={p.cron}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TriggerCard({
  hasTrigger,
  trusted,
  onOpen,
}: {
  hasTrigger: boolean;
  trusted: boolean;
  onOpen: () => void;
}) {
  if (!hasTrigger) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between rounded-xl border border-dashed border-border px-4 py-3 text-left hover:bg-muted/50"
      >
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <PlusIcon className="size-4" />
          Add a trigger script
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          Optional
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-0.5 rounded-xl border border-border px-4 py-3 text-left hover:bg-muted/50"
    >
      <span className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <CodeXmlIcon className="size-4 text-muted-foreground" />
          <span className="font-mono text-[13px] font-medium text-foreground">
            trigger.sh
          </span>
          {!trusted && (
            <span className="rounded-full bg-[#B42318]/10 px-2 py-0.5 text-[11px] text-[#B42318]">
              Review required
            </span>
          )}
        </span>
        <span className="text-[13px] text-muted-foreground">Open ›</span>
      </span>
      <span className="text-[13px] text-muted-foreground">
        Runs only when trigger.sh exits 0.
      </span>
    </button>
  );
}

// The combined harness+model selector and the reasoning selector. Standalone
// (not coupled to a task chat) — value format mirrors DelegationBand's.
function AgentSelectors({
  harness,
  model,
  reasoning,
  onChange,
}: {
  harness: Harness;
  model: string;
  reasoning: string;
  onChange: (harness: Harness, model: string, reasoning: string) => void;
}) {
  const reasoningOpts = reasoningOptions(harness, model);
  return (
    <>
      <Select
        value={`${harness}|${model}`}
        onValueChange={(v) => {
          if (typeof v !== "string") return;
          const [h, m] = v.split("|") as [Harness, string];
          onChange(h, m, defaultReasoning(h, m));
        }}
      >
        <SelectTrigger className="h-7 gap-1.5 border-0 px-1.5 hover:bg-muted">
          <span className="flex items-center gap-1.5">
            <HarnessIcon harness={harness} className="size-3.5" />
            <span className="text-sm font-medium text-foreground">
              {harness === "codex" ? "Codex" : "Claude"}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {modelLabel(harness, model)}
            </span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {HARNESSES.flatMap((h) =>
            MODELS_BY_HARNESS[h].map((m) => (
              <SelectItem key={`${h}|${m.id}`} value={`${h}|${m.id}`}>
                <HarnessIcon harness={h} className="size-3.5" />
                {h === "codex" ? "Codex" : "Claude"} {m.label}
              </SelectItem>
            )),
          )}
        </SelectContent>
      </Select>
      <span className="h-4 w-px bg-border" />
      <Select
        value={reasoning}
        onValueChange={(v) => {
          if (typeof v === "string") onChange(harness, model, v);
        }}
      >
        <SelectTrigger className="h-7 gap-1.5 border-0 px-1.5 hover:bg-muted">
          <span className="text-sm font-medium text-foreground">
            {reasoningLabel(harness, reasoning, model)}
          </span>
        </SelectTrigger>
        <SelectContent>
          {reasoningOpts.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

function RunHistoryRow({
  run,
  projectId,
  projectCwd,
  now,
  onOpen,
}: {
  run: LoopRun;
  projectId: Id<"projects">;
  projectCwd?: string;
  now: Date;
  onOpen: () => void;
}) {
  const chat = chatRefFor(run, projectCwd);
  const dur = runDuration(run, now.getTime());
  const status = surfacedStatus(run.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-4 rounded-lg px-1 py-2.5 text-left hover:bg-muted/60"
    >
      <span className="flex w-[120px] shrink-0 items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status === "Running" ? "bg-[#EAB308]" : "bg-muted-foreground/30",
          )}
        />
        <span className="text-sm font-medium text-foreground">{status}</span>
      </span>
      <span className="min-w-0 grow truncate text-sm text-muted-foreground">
        {runSummaryText(run)}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground/70">
        {dur ?? "–"}
      </span>
      <span className="w-[110px] shrink-0" onClick={(e) => e.stopPropagation()}>
        {chat && <HarnessChip chat={chat} projectId={projectId} />}
      </span>
    </button>
  );
}

// ───────────────────────────── run detail (side sheet) ──────────────────────

function RunDetailSheet({
  projectId,
  projectCwd,
  run,
  docs,
  onOpenChange,
}: {
  projectId: Id<"projects">;
  projectCwd?: string;
  run: LoopRun | null;
  docs: LoopDoc[];
  onOpenChange: (open: boolean) => void;
}) {
  const now = useNow(run?.status === "running");
  const title = run
    ? (docs.find((d) => d.loopPath === run.loopPath)?.title ??
      run.loopPath.replace(/^loops\//, ""))
    : "";
  const chat = run ? chatRefFor(run, projectCwd) : null;
  const dur = run ? runDuration(run, now.getTime()) : null;
  return (
    <Sheet open={run !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[440px] sm:max-w-[440px]">
        {run && (
          <div className="flex flex-col gap-5 px-5 py-5">
            <SheetHeader className="border-0 p-0">
              <SheetTitle className="flex items-center gap-2 text-base">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    run.status === "running"
                      ? "bg-[#EAB308]"
                      : "bg-muted-foreground/30",
                  )}
                />
                {surfacedStatus(run.status)}
                <span className="text-sm font-normal text-muted-foreground">
                  · {run.reason === "manual" ? "manual" : "scheduled"}
                </span>
              </SheetTitle>
              <SheetDescription className="sr-only">
                Run details for {title}
              </SheetDescription>
            </SheetHeader>

            <p className="text-[15px] text-foreground">{runSummaryText(run)}</p>

            {chat && (
              <div className="rounded-xl border border-border p-3">
                <HarnessChip chat={chat} projectId={projectId} />
              </div>
            )}

            <div className="flex flex-col gap-0">
              <span className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Details
              </span>
              <DetailRow label="Automation" value={title} />
              <DetailRow
                label="Reason"
                value={run.reason === "manual" ? "Manual" : "Scheduled (cron)"}
              />
              <DetailRow
                label="Started"
                value={new Date(run.startedAt).toLocaleString()}
              />
              <DetailRow label="Duration" value={dur ?? "–"} />
              <DetailRow
                label="Harness"
                value={`${run.harness === "codex" ? "Codex" : "Claude"}${
                  run.model ? ` ${run.model}` : ""
                }${run.reasoning ? ` · ${run.reasoning}` : ""}`}
              />
              {run.triggerExitCode != null && (
                <DetailRow
                  label="Trigger gate"
                  value={`exit ${run.triggerExitCode} · ${
                    run.triggerExitCode === 0 ? "ran" : "skipped"
                  }`}
                  mono
                />
              )}
            </div>

            {(run.triggerStderr || run.triggerStdout || run.error) && (
              <div className="flex flex-col gap-2">
                {run.triggerStdout && (
                  <LogBlock label="Trigger output" text={run.triggerStdout} />
                )}
                {run.triggerStderr && (
                  <LogBlock label="Logs" text={run.triggerStderr} />
                )}
                {run.error && <LogBlock label="Error" text={run.error} />}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-sm text-foreground",
          mono && "font-mono text-[13px]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function LogBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-2 font-mono text-[12px] text-foreground">
        {text}
      </pre>
    </div>
  );
}
