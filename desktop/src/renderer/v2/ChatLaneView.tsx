"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, LoaderCircle } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import {
  chatAgentDetail,
  chatIsFocusable,
  chatStatusLine,
  laneRowAction,
  laneSpansMachines,
  laneStopLabel,
  openChatHint,
} from "./chatLane";
import { serverHarnessLabel } from "./delegation";
import { StaticHarnessChip } from "./HarnessChip";
import type { TaskChat } from "./todoGroups";
import type { AssignmentRow, ChatRow, MachineRow } from "./useAssignments";
import { useOpenChat } from "./useOpenChat";

// The task's CHAT LANE: one row per agent chat, plus the header that counts them
// and the disclosure that hides the finished ones.
//
// It replaced a one-slot bar. `selectLatestAssignment` + `deriveBarState` used to
// fold a task's whole assignment history down to its newest row and render one of
// three states (compose / active / re-delegate). A task can carry SEVERAL live
// chats at once (assignments are append-only and POST /assignments has no
// one-live-per-task guard), so that fold made every other agent on the task
// invisible: a second agent blocked on the user simply wasn't on screen, and
// "Stop" ended whichever one happened to be newest. Both derivations are gone.
//
//   visible  — chats still IN PLAY (needs-you / working), in the order
//              chatsForTask returns (attention band first, newest first inside a
//              band). Each row: the harness avatar with its status ring, the
//              agent + launch params, an honest status + age, and the actions
//              that belong to THAT chat (Open chat, Stop, or Mark reviewed).
//   earlier  — finished-and-acked chats collapse behind an "N earlier chats"
//              disclosure. They keep Open chat (the chat still exists and cmux
//              can bring it back) and lose Stop (there is nothing to stop).
//
// The lane's SHAPE — its order and the visible/earlier split — is derived in
// todoGroups; a row's lifecycle wording is derived in chatLane. This file is the
// rendering and the mutations.
//
// (Named `ChatLaneView.tsx` rather than `ChatLane.tsx` only because macOS is
// case-insensitive and `chatLane.ts` — the pure policy module — already owns that
// name. The component itself is `ChatLane`; please don't "fix" the filename.)

// The client-writable half of PATCH /assignments/:id (server validation.ts:
// assignmentClientUpdate). observed_state / chat_id are daemon-only.
type AssignmentPatch = { desiredState: "stopped" } | { reviewedAt: string };

/**
 * PATCH one or more assignments, then refetch the lane.
 *
 * One hook for both writers the lane has — a row's Stop / Mark reviewed and the
 * header's Stop all — because they only ever differed in how many ids they
 * addressed: same busy latch, same fire-and-log error handling, same
 * invalidate-either-way. Two copies of that is how the "Stop" that hit the wrong
 * agent got written in the first place. Each call site holds its OWN instance, so
 * a row's spinner stays that row's and Stop all's stays the header's.
 */
function useAssignmentPatch(client: HitchClient) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const patch = useCallback(
    async (ids: readonly string[], json: AssignmentPatch) => {
      setBusy(true);
      try {
        await Promise.all(
          ids.map(async (id) => {
            const response = await client.assignments[":id"].$patch({
              param: { id },
              json,
            });
            if (!response.ok) {
              throw new Error(`Failed to update assignment (${response.status})`);
            }
          }),
        );
      } catch (error) {
        console.error("Failed to update assignment", error);
      } finally {
        // Refetch either way: a partial failure still landed some of the
        // patches, and the lane must show what actually happened.
        await queryClient.invalidateQueries({ queryKey: ["assignments"] });
        setBusy(false);
      }
    },
    [client, queryClient],
  );
  return { busy, patch };
}

const rowsClass = "flex flex-col divide-y divide-[#EDEDED] dark:divide-border/60";

export interface ChatLaneProps {
  client: HitchClient;
  /** Chats still in play, in lane order (todoGroups' `partitionLaneChats`). */
  visible: readonly TaskChat<AssignmentRow>[];
  /** Finished-and-acked chats, behind the disclosure. */
  earlier: readonly TaskChat<AssignmentRow>[];
  /** GET /machines, for resolving a row's machine name. */
  machines: readonly MachineRow[] | undefined;
  /**
   * GET /chats by id. A row reads its own chat to learn whether Hitch can reach
   * it (`handle`) — a LINKED chat was running before Hitch knew about it, so
   * there is nothing to focus and nothing to close. A missing entry means "not
   * read yet", which chatIsFocusable treats as reachable.
   */
  chatsById: ReadonlyMap<string, ChatRow>;
  /**
   * The assignments a Stop all would target — `assignmentsToStopOnDone`, the
   * SAME predicate close-on-done uses, never a second one that could drift.
   */
  stoppableIds: readonly string[];
  /** The band's shared clock, so every row's age ticks together. */
  now: number;
}

export function ChatLane({
  client,
  visible,
  earlier,
  machines,
  chatsById,
  stoppableIds,
  now,
}: ChatLaneProps) {
  const [earlierOpen, setEarlierOpen] = useState(false);
  const { busy: stoppingAll, patch } = useAssignmentPatch(client);

  // Machine chrome only when the lane actually spans machines; one machine is
  // the norm and naming it on every row says nothing. Read over the WHOLE lane
  // (visible + earlier) so expanding the disclosure can't relabel an earlier
  // chat's machine as this one.
  const showMachines = useMemo(
    () => laneSpansMachines([...visible, ...earlier]),
    [visible, earlier],
  );
  const machineNames = useMemo(
    () => new Map((machines ?? []).map((m) => [m.id, m.name] as const)),
    [machines],
  );
  const machineNameFor = (chat: TaskChat<AssignmentRow>) =>
    showMachines ? (machineNames.get(chat.assignment.machineId) ?? null) : null;

  const rows = (chats: readonly TaskChat<AssignmentRow>[]) => (
    <div className={rowsClass}>
      {chats.map((chat) => (
        <LaneRow
          key={chat.assignment.id}
          client={client}
          chat={chat}
          machineName={machineNameFor(chat)}
          // chat_id once the daemon confirms, requested_chat_id before that. A
          // linked row knows WHICH chat it adopted from the moment it is
          // written, so the row can be honest about reachability immediately
          // instead of claiming "Stop" for the tick before adoption lands.
          chatRow={chatsById.get(
            chat.assignment.chatId ?? chat.assignment.requestedChatId ?? "",
          )}
          now={now}
        />
      ))}
    </div>
  );

  return (
    <>
      {visible.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          {/* Counts the VISIBLE chats only — the earlier disclosure carries its
              own count, and a header that folded both in would name a number the
              rows below it don't add up to. */}
          <span className="text-[12px] font-medium text-[#717171] dark:text-muted-foreground">
            {visible.length} chat{visible.length === 1 ? "" : "s"}
          </span>
          {/* Stop all — a bulk action, so it only earns its place when there is
              a bulk to act on: two or more chats that would actually be stopped.
              With one, the row's own Stop is the same click with a clearer
              target.

              NEUTRAL at rest, like every other ghost control in the band. Red is
              this system's DANGER colour, not its "affects several rows" colour,
              and a secondary bulk control rendered in it was the loudest pixel in
              the dialog — louder than the task's own text, and far louder than the
              per-row Stop buttons that do the same thing with a smaller blast
              radius. Amber is the only voice allowed to be raised here. The
              destructive tone arrives on hover/focus, where the user is already
              committing to it. */}
          {stoppableIds.length >= 2 && (
            <button
              type="button"
              onClick={() => void patch(stoppableIds, { desiredState: "stopped" })}
              disabled={stoppingAll}
              className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-[#717171] hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none disabled:opacity-60 dark:text-muted-foreground"
            >
              {stoppingAll && <LoaderCircle className="size-3 animate-spin" />}
              Stop all
            </button>
          )}
        </div>
      )}

      {visible.length > 0 && rows(visible)}

      {earlier.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setEarlierOpen((v) => !v)}
            aria-expanded={earlierOpen}
            className="flex h-6.5 w-fit items-center gap-1 rounded-md px-1 text-[12px] font-medium text-[#717171] hover:bg-black/5 dark:text-muted-foreground dark:hover:bg-white/5"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform motion-reduce:transition-none",
                earlierOpen && "rotate-90",
              )}
              aria-hidden
            />
            {earlier.length} earlier chat{earlier.length === 1 ? "" : "s"}
          </button>
          {earlierOpen && rows(earlier)}
        </div>
      )}
    </>
  );
}

// One chat in the lane. Everything it renders is about THIS assignment: the
// avatar's ring state, the launch params, the age, and the actions — so Stop can
// no longer hit the wrong agent, which was the whole point of the slice.
function LaneRow({
  client,
  chat,
  machineName,
  chatRow,
  now,
}: {
  client: HitchClient;
  chat: TaskChat<AssignmentRow>;
  /** The resolved machine name, or null when the lane doesn't name machines. */
  machineName: string | null;
  /** This row's chat, when the chats query has it. Undefined = not read yet. */
  chatRow: ChatRow | undefined;
  /** The band's shared clock, so every row's age ticks together. */
  now: number;
}) {
  const { assignment, state } = chat;
  const { busy, patch } = useAssignmentPatch(client);
  // Open chat: the shared focus relay, addressed to THIS chat. Disabled until
  // the daemon has linked one (chatId is written at spawn), which is also the
  // window where cmux has nothing to focus.
  // ...and disabled FOREVER for a chat Hitch didn't launch: adopting a chat the
  // user started by hand gives us a fully observable session with no handle, so
  // the focus relay has nothing to drive. The hook owns both reasons; the row
  // only has to word them. Stop likewise cannot close what it never opened, so
  // it becomes the verb that describes what actually happens.
  const { canOpen, blockedBy, openChat } = useOpenChat({
    ...assignment,
    handle: chatRow?.handle,
  });
  const focusable = chatIsFocusable(chatRow?.handle);
  const action = laneRowAction(assignment);

  return (
    <div data-testid="v2-chat-lane-row" className="flex items-center gap-2.5 py-2">
      {/* The row's instrument, borrowed whole from the todo row's chip so the two
          surfaces can't drift: brand mark inside, status in the ring, amber dot
          for needs-you. Static — the actions are their own controls here. */}
      <StaticHarnessChip harness={assignment.harness} state={state} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-[13px] font-medium text-[#222222] dark:text-foreground">
            {serverHarnessLabel(assignment.harness)}
          </span>
          <span className="truncate text-[12.5px] text-[#717171] dark:text-muted-foreground">
            {chatAgentDetail(assignment)}
          </span>
          {machineName !== null && (
            <span className="shrink-0 text-[12.5px] text-[#717171] dark:text-muted-foreground">
              on {machineName}
            </span>
          )}
        </div>
        {/* Status + age, always neutral: needs-you's amber is the chip's ring +
            dot, and ONE amber mark per row is the whole point of that treatment.
            (The V1 chip's amber status TEXT came off for the same reason when the
            ring came back — see HarnessChip.) */}
        <span
          data-testid="v2-delegate-chip"
          data-chip-state={state}
          className="truncate text-[12px] text-[#717171] dark:text-muted-foreground"
        >
          {chatStatusLine(assignment, now)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={openChat}
                disabled={!canOpen}
                aria-label="Open chat"
                className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-black/5 disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent dark:hover:bg-white/5"
              />
            }
          >
            <ArrowUpRight className="size-3.5" />
            Open chat
          </TooltipTrigger>
          <TooltipContent>{openChatHint(blockedBy)}</TooltipContent>
        </Tooltip>
        {action !== "none" && (
          <button
            type="button"
            onClick={() =>
              void patch(
                [assignment.id],
                action === "stop"
                  ? { desiredState: "stopped" }
                  : { reviewedAt: new Date().toISOString() },
              )
            }
            disabled={busy}
            className="flex h-8 items-center rounded-md border border-[#DEDEDE] px-3 text-[13px] font-medium text-foreground hover:bg-black/5 disabled:opacity-60 dark:border-border dark:hover:bg-white/5"
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : action === "stop" ? (
              laneStopLabel(focusable)
            ) : (
              // The same words as the list row's context menu: one action, one
              // name, and a control that says what happens rather than a state.
              "Mark reviewed"
            )}
          </button>
        )}
      </div>
    </div>
  );
}
