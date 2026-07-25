import { XIcon } from "lucide-react";

import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import { Chip } from "./marks";
import { ageMs, evidenceEntries, formatAge, type InspectorChatLike } from "./model";
import { useChatEvents } from "./useInspectorData";

// The row drawer: the two things a table cell can't hold — the full evidence
// blob behind the axes, and the relayed hook-event tail behind the block
// (§9). Side by side, because the question is almost always "what did the
// sensor see, and what did the hooks say about it".
//
// Bottom-anchored rather than a right rail: the table is wide by nature and a
// side panel would squeeze the very columns you opened the drawer to explain.

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase leading-[12px] tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 border-b border-border/60 py-1 last:border-b-0">
      <span className="w-[132px] shrink-0 truncate font-mono text-[11px] leading-[16px] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-[16px] tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

export function EvidenceDrawer({
  chat,
  client,
  now,
  onClose,
}: {
  chat: InspectorChatLike;
  client: HitchClient;
  now: number;
  onClose: () => void;
}) {
  const events = useChatEvents(client, chat.id);
  const entries = evidenceEntries(chat.evidence);

  return (
    <section
      data-testid="inspector-drawer"
      aria-label="Chat evidence"
      className="flex h-[290px] shrink-0 flex-col border-t border-border bg-background"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate text-[12.5px] font-medium text-foreground">{chat.title}</span>
        <Chip title={chat.sessionId ?? undefined}>{chat.sessionId ?? "no session id"}</Chip>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close evidence"
          className="rounded-[6px] p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 md:grid-cols-2">
        <div className="min-h-0 overflow-auto border-b border-border px-3 py-2.5 md:border-b-0 md:border-r">
          <SectionTitle>Evidence</SectionTitle>
          {/* The identity fields first: they are not part of the evidence blob
              but they are what the blob is evidence ABOUT. Process identity is
              (pid, start-time), never a bare pid — that pair is what defeats
              PID reuse, so both are shown together. */}
          <KeyValue label="cwd" value={chat.cwd ?? "—"} />
          <KeyValue
            label="process"
            value={
              chat.pid === null
                ? "no process"
                : `pid ${chat.pid} · started ${chat.processStartedAt ?? "unknown"}`
            }
          />
          <KeyValue label="machine" value={chat.machineName ?? chat.machineId} />
          <KeyValue label="last_observed_at" value={chat.lastObservedAt ?? "never"} />
          <KeyValue label="last_activity_at" value={chat.lastActivityAt} />
          <KeyValue
            label="handle"
            value={chat.handle == null ? "none" : JSON.stringify(chat.handle)}
          />
          {entries.length === 0 ? (
            <div className="py-2 text-[12px] text-muted-foreground">
              No evidence recorded for this chat.
            </div>
          ) : (
            entries.map((entry) => (
              <KeyValue key={entry.key} label={entry.key} value={entry.value} />
            ))
          )}
        </div>

        <div className="min-h-0 overflow-auto px-3 py-2.5">
          <SectionTitle>Relayed events</SectionTitle>
          {events.isPending && (
            <div className="py-2 text-[12px] text-muted-foreground">Loading…</div>
          )}
          {events.isError && (
            <div className="py-2 text-[12px] text-[var(--ins-alarm)]">
              Could not load the event tail.
            </div>
          )}
          {events.data?.length === 0 && (
            <div className="py-2 text-[12px] text-muted-foreground">
              No hook events have been relayed for this chat.
            </div>
          )}
          {events.data?.map((event) => (
            <div
              key={event.id}
              className="flex items-baseline gap-2 border-b border-border/60 py-1 last:border-b-0"
            >
              <span className="w-[48px] shrink-0 text-right font-mono text-[11px] leading-[16px] tabular-nums text-muted-foreground">
                {formatAge(ageMs(event.at, now))}
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-[11px] leading-[16px]",
                  event.kind.startsWith("block.")
                    ? "text-[var(--ins-wait)]"
                    : "text-foreground",
                )}
              >
                {event.kind}
              </span>
              {event.payload != null && (
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-[16px] text-muted-foreground">
                  {JSON.stringify(event.payload)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
