import { AlertTriangleIcon, LinkIcon, UnlinkIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { ActivityMark, BlockMark, Chip, ExistenceMark, StatusMark } from "./marks";
import {
  ageMs,
  formatAge,
  hasStaleEvidence,
  shortCwd,
  shortSession,
  type InspectorChatLike,
  type InspectorMachineLike,
} from "./model";

// The table. Its one structural idea, from §9: the three OBSERVED axes are
// grouped under a single "observed on machine" header, and Status sits OUTSIDE
// that group behind a rule — because status is a conclusion the server drew,
// not a thing anybody saw. When the two disagree, the layout is what makes the
// disagreement visible.
//
// Column widths are fixed and the whole table scrolls inside its own container;
// the page body never scrolls sideways.

const COL = {
  chat: "min-w-[280px]",
  harness: "w-[104px]",
  existence: "w-[110px]",
  activity: "w-[88px]",
  block: "w-[104px]",
  status: "w-[104px]",
  seen: "w-[76px]",
  attached: "w-[220px]",
};

// The observed group's tonal surface — a faint tint of the app's muted layer,
// applied to header AND cells so the group reads as one region down the whole
// table rather than as a header decoration.
const OBSERVED_CELL = "bg-muted/40";

function HeadLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-2.5 pb-1.5 pt-1 text-left align-bottom text-[10px] font-medium uppercase leading-[12px] tracking-[0.06em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function ChatTable({
  chats,
  machinesById,
  now,
  selectedId,
  onSelect,
}: {
  chats: InspectorChatLike[];
  machinesById: Map<string, InspectorMachineLike>;
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10 bg-background">
          {/* Row 1 spans the group. The colSpan IS the grouping — the three
              axes live under one owner, and that owner is the machine. */}
          <tr>
            <th className="border-b border-border" />
            <th className="border-b border-border" />
            <th
              colSpan={3}
              scope="colgroup"
              className={cn(
                "border-b border-l border-border px-2.5 pb-1 pt-2 text-left text-[10px] font-medium uppercase leading-[12px] tracking-[0.06em] text-muted-foreground",
                OBSERVED_CELL,
              )}
            >
              Observed on machine
            </th>
            <th className="border-b border-l border-border" />
            <th className="border-b border-border" />
            <th className="border-b border-border" />
          </tr>
          <tr>
            <HeadLabel className={cn(COL.chat, "border-b border-border")}>Chat</HeadLabel>
            <HeadLabel className={cn(COL.harness, "border-b border-border")}>Harness</HeadLabel>
            <HeadLabel className={cn(COL.existence, "border-b border-l border-border", OBSERVED_CELL)}>
              Existence
            </HeadLabel>
            <HeadLabel className={cn(COL.activity, "border-b border-border", OBSERVED_CELL)}>
              Activity
            </HeadLabel>
            <HeadLabel className={cn(COL.block, "border-b border-border", OBSERVED_CELL)}>
              Block
            </HeadLabel>
            <HeadLabel className={cn(COL.status, "border-b border-l border-border")}>
              Status
            </HeadLabel>
            <HeadLabel className={cn(COL.seen, "border-b border-border")}>Seen</HeadLabel>
            <HeadLabel className={cn(COL.attached, "border-b border-border")}>Attached</HeadLabel>
          </tr>
        </thead>
        <tbody>
          {chats.map((chat) => {
            const machine = machinesById.get(chat.machineId);
            const stale = hasStaleEvidence(chat, machine, now);
            const selected = selectedId === chat.id;
            return (
              <tr
                key={chat.id}
                data-testid="inspector-chat-row"
                data-status={chat.status}
                data-stale={stale ? "true" : "false"}
                tabIndex={0}
                onClick={() => onSelect(chat.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(chat.id);
                  }
                }}
                className={cn(
                  "cursor-default outline-none",
                  selected ? "bg-accent" : "hover:bg-muted/60",
                  chat.status === "dead" && "opacity-55",
                )}
              >
                <td className={cn("border-b border-border px-2.5 py-1.5", COL.chat)}>
                  <div className="truncate leading-[17px] text-foreground">{chat.title}</div>
                  <div className="flex items-center gap-1.5 truncate font-mono text-[11px] leading-[15px] text-muted-foreground">
                    <span className="truncate" title={chat.cwd ?? undefined}>
                      {shortCwd(chat.cwd)}
                    </span>
                    <span aria-hidden className="text-[var(--ins-dead)]">·</span>
                    <span className="shrink-0" title={chat.sessionId ?? undefined}>
                      {shortSession(chat.sessionId)}
                    </span>
                  </div>
                </td>
                <td className={cn("border-b border-border px-2.5 py-1.5 align-top", COL.harness)}>
                  <Chip>{chat.harness}</Chip>
                </td>
                <td
                  className={cn(
                    "border-b border-l border-border px-2.5 py-1.5 align-top",
                    OBSERVED_CELL,
                    COL.existence,
                  )}
                >
                  <ExistenceMark value={chat.existence} />
                </td>
                <td
                  className={cn(
                    "border-b border-border px-2.5 py-1.5 align-top",
                    OBSERVED_CELL,
                    COL.activity,
                  )}
                >
                  <ActivityMark value={chat.activity} />
                </td>
                <td
                  className={cn(
                    "border-b border-border px-2.5 py-1.5 align-top",
                    OBSERVED_CELL,
                    COL.block,
                  )}
                >
                  <BlockMark value={chat.block} />
                </td>
                <td
                  className={cn(
                    "border-b border-l border-border px-2.5 py-1.5 align-top",
                    COL.status,
                  )}
                >
                  <StatusMark status={chat.status} />
                </td>
                <td
                  className={cn(
                    "border-b border-border px-2.5 py-1.5 align-top tabular-nums",
                    COL.seen,
                    stale ? "text-[var(--ins-alarm)]" : "text-muted-foreground",
                  )}
                  title={
                    stale
                      ? `${chat.lastObservedAt ?? "never observed"} — still claims to exist, but was NOT in this machine's latest snapshot`
                      : (chat.lastObservedAt ?? "never observed")
                  }
                >
                  {/* Shape as well as colour, and here it does real work: a
                      stale row's age can read "0s" (the last tick was seconds
                      ago — it just didn't include this chat), so the number
                      alone would say the opposite of the truth. */}
                  <span className="flex items-center gap-1">
                    {stale && <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />}
                    {formatAge(ageMs(chat.lastObservedAt, now))}
                  </span>
                </td>
                <td className={cn("border-b border-border px-2.5 py-1.5 align-top", COL.attached)}>
                  <Attachment chat={chat} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {chats.length === 0 && (
        <div className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">
          No chats match this filter.
        </div>
      )}
    </div>
  );
}

// Attachment is TWO independent things (§4): the task this chat serves, and a
// handle to focus it. A chat with neither is a complete, correct chat — so the
// missing case is stated plainly rather than treated as an error.
function Attachment({ chat }: { chat: InspectorChatLike }) {
  const handle = chat.handle != null;
  const label = chat.task?.title ?? chat.projectName ?? null;
  return (
    <div className="flex items-center gap-1.5">
      {label ? (
        <Chip className="min-w-0" title={label}>
          <span className="truncate">{label}</span>
        </Chip>
      ) : (
        <span className="text-[12px] text-[var(--ins-dead)]">unattached</span>
      )}
      {handle ? (
        <LinkIcon className="size-3 shrink-0 text-muted-foreground" aria-label="has handle" />
      ) : (
        <UnlinkIcon className="size-3 shrink-0 text-[var(--ins-dead)]" aria-label="no handle" />
      )}
    </div>
  );
}
