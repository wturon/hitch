import { useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useHitchServer } from "@/lib/server/HitchServerProvider";
import { cn } from "@/lib/utils";
import { ChatTable } from "./ChatTable";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { HealthStrip } from "./HealthStrip";
import {
  FILTERS,
  FILTER_LABELS,
  filterCounts,
  formatAge,
  matchesFilter,
  type InspectorChatLike,
  type InspectorFilter,
  type InspectorMachineLike,
} from "./model";
import { useInspectorChats, useInspectorMachines } from "./useInspectorData";

// Chat Inspector — a DEV-ONLY debug window (docs/chat-tracking-redesign.md §9).
// Mounted from main.tsx on `?view=inspector`, in a second BrowserWindow that
// main.ts only ever opens behind `isDev`. It is deliberately absent from the
// product's navigation: this is the instrument for telling whether the chat
// pipeline is behaving, not a feature.
//
// It shares the app's QueryClient provider, so the WS invalidations already
// wired for `chats` / `chat_events` / `machines` keep it live with no polling
// of its own. The only local clock is the one below, which exists so the
// *ages* keep counting between server pushes.

const TICK_MS = 1_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function FilterBar({
  filter,
  counts,
  onChange,
}: {
  filter: InspectorFilter;
  counts: Record<InspectorFilter, number>;
  onChange: (next: InspectorFilter) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Chat filter"
      className="flex shrink-0 items-center gap-1 border-b border-border px-2.5 py-1.5"
    >
      {FILTERS.map((option) => {
        const active = option === filter;
        return (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`inspector-filter-${option}`}
            onClick={() => onChange(option)}
            className={cn(
              "flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12px] leading-[15px]",
              active
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {FILTER_LABELS[option]}
            <span
              className={cn(
                "tabular-nums",
                active ? "text-secondary-foreground/60" : "text-muted-foreground/60",
              )}
            >
              {counts[option]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The manual re-read, and the age of the last one.
 *
 * The window has NO polling of its own — it is kept live entirely by the
 * main-held WS invalidations. That is the right design and the reason this
 * control exists: when the socket drops, every row freezes at the last push
 * while the ages below keep climbing, which looks EXACTLY like a dead daemon.
 * `fetched Ns ago` separates the two failures at a glance (climbing = our
 * socket, not the machine), and the button is the way out of the first one.
 *
 * Invalidating by the coarse `["chats"]` prefix — not refetching the two
 * queries by hand — is deliberate: TanStack matches by prefix, so the open
 * drawer's `["chats", id, "events"]` tail comes along, and this stays correct
 * if the Inspector ever grows a fourth read.
 */
function RefreshButton({
  now,
  updatedAt,
  fetching,
}: {
  now: number;
  updatedAt: number | null;
  fetching: boolean;
}) {
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["chats"] });
    void queryClient.invalidateQueries({ queryKey: ["machines"] });
  }, [queryClient]);

  return (
    // Above the drag strip, which is a FIXED 38px bar across the whole header
    // at z-50 (styles.css) — it has no pointer-events:none, so anything under
    // it is unclickable no matter how the app-region resolves. The strip is
    // still rendered first in the DOM, so the global button no-drag is
    // subtracted after the drag union and this doesn't become a dead zone for
    // window dragging either.
    <div className="relative z-[51] ml-auto flex items-center gap-2">
      <span
        data-testid="inspector-fetched-age"
        className="text-[11.5px] tabular-nums text-muted-foreground"
        title="How old this window's copy of the server data is. The Inspector never polls — it is refreshed by WS invalidation, so if this keeps climbing the socket is down, not the daemon."
      >
        fetched {formatAge(updatedAt === null ? null : now - updatedAt)} ago
      </span>
      <button
        type="button"
        data-testid="inspector-refresh"
        onClick={refresh}
        disabled={fetching}
        title="Re-read GET /chats and GET /machines now"
        className={cn(
          "flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11.5px] leading-[15px]",
          "text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <RefreshCwIcon className={cn("size-3", fetching && "animate-spin")} aria-hidden />
        Refresh
      </button>
    </div>
  );
}

function InspectorBody() {
  const { client } = useHitchServer();
  const now = useNow();
  const [filter, setFilter] = useState<InspectorFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // client is non-null here — the shell below gates on it.
  const chatsQuery = useInspectorChats(client!);
  const machinesQuery = useInspectorMachines(client!);

  // No casts: InspectorChatLike / InspectorMachineLike are structural subsets
  // of what the server returns, so these assignments are the type check that
  // the Inspector and GET /chats still agree.
  const chats: InspectorChatLike[] = chatsQuery.data ?? [];
  const machines: InspectorMachineLike[] = machinesQuery.data ?? [];

  const machinesById = useMemo(
    () => new Map(machines.map((machine) => [machine.id, machine] as const)),
    [machines],
  );
  // Counts are computed over the WHOLE set, not the filtered one, so the bar
  // stays a census of the pipeline rather than of the current view.
  const counts = useMemo(() => filterCounts(chats, machinesById, now), [chats, machinesById, now]);
  const visible = useMemo(
    () => chats.filter((chat) => matchesFilter(filter, chat, machinesById.get(chat.machineId), now)),
    [chats, filter, machinesById, now],
  );

  const selected = chats.find((chat) => chat.id === selectedId) ?? null;

  // The OLDER of the two reads: this window is only as current as its stalest
  // half, and claiming otherwise would be the same lie as a green spool light.
  const updatedAt = useMemo(() => {
    const stamps = [chatsQuery.dataUpdatedAt, machinesQuery.dataUpdatedAt].filter(
      (value) => typeof value === "number" && value > 0,
    );
    return stamps.length === 0 ? null : Math.min(...stamps);
  }, [chatsQuery.dataUpdatedAt, machinesQuery.dataUpdatedAt]);

  // Esc closes the drawer; the window itself has no other modal state.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      {/* Frameless-window drag strip + the one bit of chrome: what this is,
          and how many rows the server is showing us. */}
      <div className="window-drag-region" aria-hidden />
      <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-border pl-[92px] pr-3">
        <span className="text-[12.5px] font-medium text-foreground">Chat Inspector</span>
        <span className="text-[11.5px] text-muted-foreground">
          {chatsQuery.isError ? "server read failed" : `${chats.length} chats`}
        </span>
        <RefreshButton
          now={now}
          updatedAt={updatedAt}
          fetching={chatsQuery.isFetching || machinesQuery.isFetching}
        />
      </header>

      <HealthStrip machines={machines} chats={chats} now={now} />
      <FilterBar filter={filter} counts={counts} onChange={setFilter} />
      <ChatTable
        chats={visible}
        machinesById={machinesById}
        now={now}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
      />
      {selected && (
        <EvidenceDrawer
          chat={selected}
          client={client!}
          now={now}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

export default function InspectorApp() {
  const { authReady, client } = useHitchServer();
  // index.html's <title> is the product's, and a document title always wins
  // over BrowserWindow's `title` option — so the window would otherwise show
  // up as a second "Hitch" in the Window menu and the app switcher.
  useEffect(() => {
    document.title = "Chat Inspector";
  }, []);
  return (
    // The scope for the semantic status ramp (styles.css). Everything inside
    // reads --ins-*; nothing outside this class can see them.
    <div className="hitch-inspector h-screen bg-background text-foreground">
      {!authReady ? null : !client ? (
        <div className="flex h-screen flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="window-drag-region" aria-hidden />
          <p className="text-[13px] text-foreground">Not signed in</p>
          <p className="text-[12px] text-muted-foreground">
            The Inspector is a pure server read — sign in from the main window.
          </p>
        </div>
      ) : (
        <InspectorBody />
      )}
    </div>
  );
}
