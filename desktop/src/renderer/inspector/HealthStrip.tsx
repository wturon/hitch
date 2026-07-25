import { AlertTriangleIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { AlarmChip } from "./marks";
import {
  ageMs,
  formatAge,
  isInWindow,
  snapshotHealth,
  type InspectorChatLike,
  type InspectorMachineLike,
} from "./model";

// The health strip — ABOVE everything, because a stale snapshot means every row
// under it is fiction (docs/chat-tracking-redesign.md §9). One line per
// machine: how old the last snapshot is, how far back it looked, whether it
// saw everything, and how many chats it carried.
//
// Staleness is the loud state, and it is loud structurally: the whole line
// takes an alarm-tinted surface and a left rule, so it reads at a glance
// across the room rather than as one differently-coloured word.

// Spool backlog (§9's fifth field) is NOT rendered, and is not faked. The
// daemon drains its spool dir and relays the events inside the snapshot; the
// depth of that dir is never put on the wire, so the server genuinely does not
// know it. Rendering a zero here would be the one thing worse than omitting
// it: a permanently green early-warning light. Reporting it would mean adding
// a counter to §7's `window` block and to the daemon's tick.

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="text-[10px] font-medium uppercase leading-[12px] tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-[12.5px] leading-[16px] tabular-nums">{children}</span>
    </div>
  );
}

function MachineHealth({
  machine,
  chats,
  now,
}: {
  machine: InspectorMachineLike;
  chats: InspectorChatLike[];
  now: number;
}) {
  const { health, ageMs: snapshotAge } = snapshotHealth(machine, now);
  const alarm = health !== "fresh";
  const mine = chats.filter((c) => c.machineId === machine.id);
  const inWindow = mine.filter(isInWindow).length;
  const truncated = machine.chatWindowTruncated === true;
  const windowSpan = ageMs(machine.chatWindowSince, now);
  const heartbeat = ageMs(machine.lastSeenAt, now);

  return (
    <div
      data-testid="inspector-machine-health"
      data-health={health}
      className={cn(
        "flex flex-wrap items-start gap-x-7 gap-y-3 border-l-2 py-2.5 pl-3 pr-3",
        alarm
          ? "border-l-[var(--ins-alarm)] bg-[var(--ins-alarm-bg)]"
          : "border-l-transparent bg-transparent",
      )}
    >
      <Field label="Snapshot" className="w-[104px]">
        {health === "never" ? (
          <AlarmChip>
            <AlertTriangleIcon className="size-3" aria-hidden />
            no snapshot
          </AlarmChip>
        ) : alarm ? (
          <AlarmChip>
            <AlertTriangleIcon className="size-3" aria-hidden />
            {formatAge(snapshotAge)} old
          </AlarmChip>
        ) : (
          <span className="text-foreground">{formatAge(snapshotAge)} ago</span>
        )}
      </Field>

      <Field label="Machine" className="w-[128px]">
        <span className="text-foreground" title={machine.name}>
          {machine.name}
        </span>
      </Field>

      <Field label="Heartbeat" className="w-[64px]">
        <span className="text-muted-foreground">{formatAge(heartbeat)} ago</span>
      </Field>

      <Field label="Window" className="w-[92px]">
        <span className="text-muted-foreground">
          {windowSpan === null ? "—" : `${formatAge(windowSpan)} back`}
        </span>
      </Field>

      <Field label="Cap" className="w-[48px]">
        <span className="text-muted-foreground">{machine.chatWindowCap ?? "—"}</span>
      </Field>

      <Field label="Coverage" className="w-[96px]">
        {machine.chatWindowTruncated === null ? (
          <span className="text-muted-foreground">—</span>
        ) : truncated ? (
          <AlarmChip>partial</AlarmChip>
        ) : (
          <span className="text-muted-foreground">complete</span>
        )}
      </Field>

      <Field label="In window" className="w-[72px]">
        <span className="text-foreground">
          {inWindow}
          <span className="text-muted-foreground"> / {mine.length}</span>
        </span>
      </Field>

      <Field label="Spool" className="w-[92px]">
        <span
          className="text-[var(--ins-dead)]"
          title="Not reported. The daemon drains its spool dir into the snapshot's events array; the depth of that dir never goes on the wire, so the server cannot know it."
        >
          not reported
        </span>
      </Field>
    </div>
  );
}

export function HealthStrip({
  machines,
  chats,
  now,
}: {
  machines: InspectorMachineLike[];
  chats: InspectorChatLike[];
  now: number;
}) {
  return (
    <section
      aria-label="Snapshot health"
      className="shrink-0 divide-y divide-border border-b border-border"
    >
      {machines.length === 0 ? (
        <div className="px-3 py-3 text-[12.5px] text-muted-foreground">
          No machines registered — nothing has ever PUT a chat snapshot.
        </div>
      ) : (
        machines.map((machine) => (
          <MachineHealth key={machine.id} machine={machine} chats={chats} now={now} />
        ))
      )}
    </section>
  );
}
