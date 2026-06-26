// cmux Debug screen — a local-only window into the chat lifecycle. The left
// rail lists every cmux chat with its drift state; selecting one shows what
// Hitch recorded vs what cmux reports right now, plus that chat's trace. With
// nothing selected the right side is the global firehose. All data comes from
// the daemon's local store via the window.hitchDaemon bridge (never Convex).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";

import type { Id } from "@convex/_generated/dataModel";
import { useChatActions } from "@/hooks/useChats";
import { type Harness } from "@/lib/chat";
import { cn } from "@/lib/utils";

type CmuxDriftState = "ok" | "multi-surface" | "no-binding" | "closed";

interface CmuxReconcileEntry {
  chatId: string | null;
  launchId: string | null;
  harness: string;
  title: string;
  status: string;
  cwd: string;
  host: string;
  pending: boolean;
  lastEventAt: number;
  surfaces: string[];
  matchCount: number;
  drift: CmuxDriftState;
}

interface CmuxReconcileResult {
  scannedAt: number;
  driftCount: number;
  entries: CmuxReconcileEntry[];
}

interface CmuxTraceRow {
  seq: number;
  ts: number;
  chatId: string | null;
  launchId: string | null;
  kind: "io" | "decision" | "warn";
  command: string | null;
  args: string[] | null;
  durationMs: number | null;
  ok: boolean | null;
  errorCode: string | null;
  message: string | null;
}

interface DebugBridge {
  reconcileCmux: (projectId: string | null) => Promise<CmuxReconcileResult>;
  readCmuxTrace: (
    filter?: { chatId?: string | null; launchId?: string | null },
    limit?: number,
  ) => Promise<CmuxTraceRow[]>;
}

function useDebugBridge(): DebugBridge | undefined {
  return typeof window !== "undefined"
    ? (window as unknown as { hitchDaemon?: DebugBridge }).hitchDaemon
    : undefined;
}

const POLL_MS = 2500;

function shortId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 8)}` : "—";
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const DRIFT_LABEL: Record<CmuxDriftState, string> = {
  ok: "in sync",
  "multi-surface": "2+ surfaces",
  "no-binding": "no binding",
  closed: "closed",
};

function isDrift(d: CmuxDriftState): boolean {
  return d === "multi-surface" || d === "no-binding";
}

export function DebugView({
  projectId,
}: {
  projectId: Id<"projects">;
  onExit?: () => void;
}) {
  const bridge = useDebugBridge();
  const actions = useChatActions();
  const [result, setResult] = useState<CmuxReconcileResult | null>(null);
  const [trace, setTrace] = useState<CmuxTraceRow[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);

  const selected =
    result?.entries.find((e) => e.chatId === selectedChatId) ?? null;

  // Single non-overlapping poll loop: reconcile + trace, scoped to the
  // selected chat when one is open, otherwise the global firehose.
  const inFlight = useRef(false);
  const poll = useCallback(async () => {
    if (!bridge || inFlight.current) return;
    inFlight.current = true;
    try {
      const [recon, traceRows] = await Promise.all([
        bridge.reconcileCmux(projectId),
        bridge.readCmuxTrace(
          selectedChatId
            ? { chatId: selectedChatId, launchId: selected?.launchId ?? null }
            : {},
          300,
        ),
      ]);
      setResult(recon);
      setTrace(traceRows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [bridge, projectId, selectedChatId, selected?.launchId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await poll();
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [poll]);

  const entries = result?.entries ?? [];
  const driftCount = result?.driftCount ?? 0;

  async function launch(harness: Harness, prompt: string, cwd: string) {
    await actions.startChat({
      projectId,
      harness,
      initialPrompt: prompt,
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <div className="size-2 rounded-full bg-foreground" />
          <span className="text-[17px] font-semibold tracking-tight">
            cmux Debug
          </span>
          {driftCount > 0 ? (
            <span className="rounded-full bg-destructive px-2 py-0.5 text-xs font-semibold text-white">
              {driftCount} drifting
            </span>
          ) : (
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {entries.length} chats
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void poll()}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
          >
            <RefreshCwIcon className="size-3.5 text-muted-foreground" />
            Resync
          </button>
          <button
            type="button"
            onClick={() => setLaunchOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
          >
            <PlusIcon className="size-3.5" />
            Test launch
          </button>
        </div>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-border bg-muted px-4 py-2 font-mono text-xs text-muted-foreground">
          {error}
        </div>
      ) : null}

      {/* Body: inbox rail + content */}
      <div className="flex min-h-0 flex-1 flex-row">
        <ChatRail
          entries={entries}
          selectedChatId={selectedChatId}
          onSelect={(id) => setSelectedChatId(id)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? (
            <ChatDetail
              entry={selected}
              trace={trace}
              onDeselect={() => setSelectedChatId(null)}
            />
          ) : (
            <Firehose entries={entries} trace={trace} />
          )}
        </div>
      </div>

      {launchOpen ? (
        <LaunchModal
          onClose={() => setLaunchOpen(false)}
          onLaunch={async (h, p, c) => {
            await launch(h, p, c);
            setLaunchOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "working" || status === "needs-input") {
    return <div className="mt-1 size-2 shrink-0 rounded-full bg-foreground" />;
  }
  if (status === "idle") {
    return (
      <div className="mt-1 size-2 shrink-0 rounded-full border-[1.5px] border-muted-foreground" />
    );
  }
  return (
    <div className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground" />
  );
}

function DriftBadge({ drift }: { drift: CmuxDriftState }) {
  if (isDrift(drift)) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-bold text-white">
        <AlertTriangleIcon className="size-2.5" />
        {DRIFT_LABEL[drift]}
      </span>
    );
  }
  return (
    <span className="text-[11px] font-medium text-muted-foreground">
      {DRIFT_LABEL[drift]}
    </span>
  );
}

function ChatRail({
  entries,
  selectedChatId,
  onSelect,
}: {
  entries: CmuxReconcileEntry[];
  selectedChatId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col border-r border-border">
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          All cmux chats
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {entries.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-muted-foreground">
            No cmux chats yet.
          </div>
        ) : (
          entries.map((e) => {
            const active = e.chatId === selectedChatId;
            const selectable = Boolean(e.chatId);
            return (
              <button
                key={e.chatId ?? e.launchId ?? e.title}
                type="button"
                disabled={!selectable}
                title={selectable ? undefined : "Not bound to a session yet"}
                onClick={() => {
                  if (selectable) onSelect(active ? null : e.chatId);
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 border-b border-l-2 border-border px-3.5 py-3 text-left",
                  active
                    ? "border-l-foreground bg-secondary"
                    : "border-l-transparent hover:bg-muted",
                  !selectable && "cursor-default opacity-60 hover:bg-transparent",
                )}
              >
                <StatusDot status={e.status} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13.5px] font-semibold text-foreground">
                    {e.title || "Untitled chat"}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {e.harness} · {e.status}
                  </span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {fmtAgo(e.lastEventAt)}
                  </span>
                  <DriftBadge drift={e.drift} />
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function KeyRow({
  label,
  value,
  drift,
}: {
  label: string;
  value: string;
  drift?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border py-1.5 first:border-t-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-xs",
          drift ? "font-medium text-destructive" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function ReconCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-border">
      <div className="border-b border-border bg-secondary px-3.5 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="flex flex-col px-3.5 py-1.5">{children}</div>
    </div>
  );
}

function ChatDetail({
  entry,
  trace,
  onDeselect,
}: {
  entry: CmuxReconcileEntry;
  trace: CmuxTraceRow[];
  onDeselect: () => void;
}) {
  const drift = isDrift(entry.drift);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Detail header */}
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={onDeselect}
            aria-label="Deselect chat"
            className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted"
          >
            <XIcon className="size-3.5" />
          </button>
          <div className="flex flex-col gap-1">
            <span className="text-xl font-semibold tracking-tight">
              {entry.title || "Untitled chat"}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {entry.harness} · cmux · {entry.status} · sess {shortId(entry.chatId)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Resume/Focus/Kill not yet wired (need Convex id mapping / cmux
              terminate rails) — shown disabled so the surface is honest. */}
          {["Resume", "Focus", "Kill"].map((label) => (
            <span
              key={label}
              title="Not wired yet"
              className={cn(
                "flex h-8 cursor-not-allowed items-center rounded-lg border px-3 text-[13px] font-medium opacity-50",
                label === "Kill"
                  ? "border-destructive text-destructive"
                  : "border-border text-foreground",
              )}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        {/* Reconciliation */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Reconciliation
            </span>
            {drift ? (
              <span className="flex items-center gap-1.5 rounded-full bg-destructive px-2.5 py-0.5 text-xs font-semibold text-white">
                <AlertTriangleIcon className="size-3" />
                {DRIFT_LABEL[entry.drift]}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-foreground">
                <CheckIcon className="size-3" />
                in sync
              </span>
            )}
          </div>
          <ReconCard title="Hitch thinks">
            <KeyRow label="session" value={shortId(entry.chatId)} />
            <KeyRow label="harness" value={entry.harness} />
            <KeyRow label="status" value={entry.status} />
            <KeyRow label="cwd" value={entry.cwd} />
          </ReconCard>
          <ReconCard title="cmux reports">
            <KeyRow
              label="surfaces"
              value={entry.surfaces.length ? entry.surfaces.join(", ") : "none"}
              drift={drift}
            />
            <KeyRow
              label="matches"
              value={String(entry.matchCount)}
              drift={drift}
            />
          </ReconCard>
          {drift ? (
            <div className="flex items-center gap-2.5 rounded-[10px] border border-destructive bg-[#FBE9E9] px-4 py-3">
              <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
              <span className="text-[13px] leading-snug text-foreground">
                {entry.drift === "multi-surface"
                  ? `Resume focuses the first of ${entry.matchCount} surfaces — likely the wrong panel. A stale duplicate binding was never cleared.`
                  : "Hitch thinks this chat is live but cmux has no surface bound — resume will spawn a new workspace."}
              </span>
            </div>
          ) : null}
        </div>

        {/* Trace */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Trace
            </span>
            <span className="text-xs font-medium text-foreground">this chat</span>
          </div>
          <TraceTable trace={trace} showChat={false} />
        </div>
      </div>
    </div>
  );
}

function Firehose({
  entries,
  trace,
}: {
  entries: CmuxReconcileEntry[];
  trace: CmuxTraceRow[];
}) {
  const driftCount = entries.filter((e) => isDrift(e.drift)).length;
  const titleByChat = new Map<string, string>();
  for (const e of entries) if (e.chatId) titleByChat.set(e.chatId, e.title);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex shrink-0 items-center gap-3">
          <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight">
            All cmux activity
          </span>
          <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {entries.length} chats
          </span>
          {driftCount > 0 ? (
            <span className="whitespace-nowrap rounded-full bg-destructive px-2 py-0.5 text-xs font-semibold text-white">
              {driftCount} drifting
            </span>
          ) : null}
        </div>
        <span className="hidden truncate text-xs text-muted-foreground sm:block">
          Select a chat on the left to inspect its bindings &amp; trace.
        </span>
      </div>
      <TraceTable trace={trace} showChat titleByChat={titleByChat} />
    </div>
  );
}

function TraceTable({
  trace,
  showChat,
  titleByChat,
}: {
  trace: CmuxTraceRow[];
  showChat: boolean;
  titleByChat?: Map<string, string>;
}) {
  // Bridge returns newest-first; show oldest-first so the timeline reads down.
  const rows = [...trace].reverse();
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-border">
      <div className="flex items-center border-b border-border bg-secondary px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {showChat ? <span className="w-40 shrink-0">Chat</span> : null}
        <span className="w-24 shrink-0">Time</span>
        <span className="w-16 shrink-0">Kind</span>
        <span className="flex-1">Event</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 font-mono text-xs text-muted-foreground">
          No trace yet — actions appear here as they happen.
        </div>
      ) : (
        rows.map((r) => {
          const warn = r.kind === "warn" || (r.kind === "io" && r.ok === false);
          const kindLabel =
            r.kind === "io" ? "cmux" : r.kind === "warn" ? "warn" : "event";
          let text = r.message ?? r.command ?? "";
          if (r.kind === "io") {
            const suffix =
              r.ok === false
                ? ` ✗ ${r.errorCode ?? "error"}`
                : r.durationMs != null
                  ? ` · ${r.durationMs}ms`
                  : "";
            text = `${r.command ?? ""}${suffix}`;
          }
          return (
            <div
              key={r.seq}
              className={cn(
                "flex items-baseline border-b border-border px-4 py-1.5 last:border-b-0",
                warn && "bg-[#FBE9E9]",
              )}
            >
              {showChat ? (
                <span className="w-40 shrink-0 truncate font-mono text-xs text-foreground">
                  {r.chatId
                    ? (titleByChat?.get(r.chatId) ?? shortId(r.chatId))
                    : "—"}
                </span>
              ) : null}
              <span className="w-24 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {fmtClock(r.ts)}
              </span>
              <span
                className={cn(
                  "w-16 shrink-0 font-mono text-[10px] font-semibold uppercase",
                  warn ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {kindLabel}
              </span>
              <span
                className={cn(
                  "flex-1 font-mono text-xs",
                  warn ? "text-destructive" : "text-foreground",
                )}
              >
                {text}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function LaunchModal({
  onClose,
  onLaunch,
}: {
  onClose: () => void;
  onLaunch: (harness: Harness, prompt: string, cwd: string) => Promise<void>;
}) {
  const [harness, setHarness] = useState<Harness>("claude-code");
  const [prompt, setPrompt] = useState("Say hello, then exit.");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await onLaunch(harness, prompt, cwd);
    } catch {
      setBusy(false);
    }
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/45"
      onClick={onClose}
    >
      <div
        className="flex w-[540px] flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold tracking-tight">
              Test launch
            </span>
            <span className="text-[13px] text-muted-foreground">
              Fire a real launch against a working directory, then watch it land
              in the trace.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">
          <Field label="Prompt">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>
          <Field label="Harness">
            <div className="flex w-full items-center gap-1.5 rounded-lg border border-border bg-secondary p-0.5">
              {(["claude-code", "codex"] as Harness[]).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHarness(h)}
                  className={cn(
                    "flex h-8 flex-1 items-center justify-center rounded-md text-[13px] font-medium",
                    harness === h
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                >
                  {h}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Working directory">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="project root (leave blank for default)"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border bg-secondary px-5 py-3.5">
          <span className="text-xs text-muted-foreground">
            Lands in the trace as it happens.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 items-center rounded-lg px-3.5 text-[13px] font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !prompt.trim()}
              className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-4 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <PlayIcon className="size-3.5 text-foreground" />
              {busy ? "Launching…" : "Launch chat"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
