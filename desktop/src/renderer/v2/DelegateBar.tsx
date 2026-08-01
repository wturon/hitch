"use client";

import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "lucide-react";

import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import { deadLaunchNotice } from "./chatLane";
import { ChatLane } from "./ChatLaneView";
import { ComposeBlock } from "./ComposeBlock";
import { assignmentsToStopOnDone, machineAvailability } from "./delegation";
import { LinkChatPicker } from "./LinkChatPicker";
import { chatsForTask, partitionLaneChats } from "./todoGroups";
import { useAssignments, useChats, useMachines } from "./useAssignments";

// The delegate band in TaskDialog's saved stage — the task's CHAT LANE plus a
// compose block, in that order. This file is the band: the two queries, the
// shared clock, the loading gate, and the compose/lane composition. What the lane
// draws lives in ChatLaneView.tsx; what compose draws lives in ComposeBlock.tsx.
//
//   ChatLane      — one row per chat on the task (a task can carry several at
//                   once), finished ones behind an "N earlier chats" disclosure.
//   ComposeBlock  — the delegate controls. Expanded by default only when nothing
//                   is in play (a fresh task, or one whose chats have all
//                   finished), so the common case keeps its old ergonomics (open
//                   a task, type, ⌘⏎); otherwise it collapses to a "＋ Add an
//                   agent" ghost button, because the lane — not the composer —
//                   is what the user came to read.
//   LinkChatPicker — the band's SECOND door: adopt a chat already running on the
//                   machine instead of spawning one. Always rendered, in both
//                   compose states, because the case it exists for (an
//                   environment whose chats Hitch can see but has never
//                   launched) is exactly the empty-lane case where compose is
//                   expanded.
//
// Every ordering/visibility rule is derived, not eyeballed: the lane's shape in
// todoGroups, its lifecycle wording in chatLane, the picker's contents in
// linkableChats. Nothing here picks a "latest".
export interface DelegateBarProps {
  client: HitchClient;
  // The committed task id (the bar mounts only once the row exists).
  taskId: string;
  // The task's project, for the picker's "In this project" grouping. Null for a
  // task that sits outside every project.
  projectId: string | null;
  // useTaskDocument's flush: persists any dirty title/body now. Awaited before
  // every delegate so the server resolves the prompt against what's on screen.
  flushTask: () => Promise<void>;
}

const bandClass =
  "flex flex-col gap-2.5 rounded-b-xl border-t border-t-[#E8E8E8] bg-[#F9F9F9] px-5 pt-3 pb-3.5 dark:border-t-border dark:bg-muted/40";

export function DelegateBar({
  client,
  taskId,
  projectId,
  flushTask,
}: DelegateBarProps) {
  const assignmentsQuery = useAssignments(client, taskId);
  const machinesQuery = useMachines(client);
  // The live chat pool. Two readers: the picker (what can be adopted) and the
  // lane (whether a row's chat is one Hitch can actually reach).
  const chatsQuery = useChats(client);

  // One slow clock for the whole band: machine staleness AND the rows' ages
  // (both are minute-coarse, so 30s is enough resolution) advance without
  // needing a refetch, so a dialog left open doesn't freeze at "started 1m ago".
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const availability = useMemo(
    () => machineAvailability(machinesQuery.data, nowTick),
    [machinesQuery.data, nowTick],
  );

  // The lane. Order and the visible/earlier split are todoGroups' derivation.
  const chats = useMemo(
    () => chatsForTask(assignmentsQuery.data, taskId),
    [assignmentsQuery.data, taskId],
  );
  const { visible, earlier } = useMemo(() => partitionLaneChats(chats), [chats]);

  // Stop-all's target set is close-on-done's ("live and not terminal") — one
  // predicate, not a second one that could drift from it.
  const stoppableIds = useMemo(
    () => assignmentsToStopOnDone(assignmentsQuery.data, taskId),
    [assignmentsQuery.data, taskId],
  );

  // Compose's expansion. `null` = "the lane decides": open exactly when nothing
  // is in play. Keyed on the VISIBLE chats, like every other lane decision —
  // finished-and-acked history behind the disclosure is not a reason to hide the
  // delegate affordance. Clicking ＋ Add an agent pins it open; a successful
  // delegate hands the decision back to the lane, so the block folds away and the
  // new chat's row is what the user sees next.
  const [composeOverride, setComposeOverride] = useState<boolean | null>(null);
  const composeExpanded = composeOverride ?? visible.length === 0;

  // Bumped on every successful delegate to KEY the compose block, so the next
  // "Add an agent" always gets a fresh composer. Collapsing already unmounts it,
  // but that only happens if the refetched lane came back non-empty: a failed or
  // stale-empty refetch would otherwise leave compose mounted around a composer
  // latched at phase "submitted" — a permanently disabled button with a spinner
  // until the dialog is reopened. The key closes that hole structurally.
  const [launchSeq, setLaunchSeq] = useState(0);

  // The link failure, held HERE rather than in the picker: the popover closes on
  // every attempt, and a 409 that dies with the surface that triggered it never
  // gets read. Cleared on the next open.
  const [linkError, setLinkError] = useState<string | null>(null);

  // Chat rows by id, so a lane row can ask whether ITS chat carries a handle.
  const chatsById = useMemo(
    () => new Map((chatsQuery.data ?? []).map((chat) => [chat.id, chat] as const)),
    [chatsQuery.data],
  );

  // A launch that never started (see deadLaunchNotice): the lane drops `dead`
  // assignments, so without this the failure would be silent.
  const deadNotice = deadLaunchNotice(assignmentsQuery.data, taskId, visible.length);

  // Nothing is asserted until the first read lands: an un-settled query makes the
  // lane read as EMPTY, and rendering compose off that would tell a task with
  // three live agents that it has none — then jump. `data !== undefined` (not
  // !isPending) so a later refetch never blanks a band that's already up.
  if (assignmentsQuery.data === undefined) {
    return <div className={bandClass} data-testid="v2-delegate-band-loading" />;
  }

  return (
    <div className={bandClass}>
      <ChatLane
        client={client}
        visible={visible}
        earlier={earlier}
        machines={machinesQuery.data}
        chatsById={chatsById}
        stoppableIds={stoppableIds}
        now={nowTick}
      />

      {/* Compose. A hairline separates it from the lane above rather than a
          second surface — the band stays one flat plane. */}
      <div
        className={cn(
          "flex flex-col gap-2.5",
          chats.length > 0 && "border-t border-[#EDEDED] pt-2.5 dark:border-border/60",
        )}
      >
        {/* The launch that never started: one muted line, no chip, no row, no
            amber. It's a fact about the last attempt, not a state to act on. */}
        {deadNotice && (
          <p className="text-[12px] text-[#717171] dark:text-muted-foreground">
            {deadNotice}
          </p>
        )}
        {composeExpanded && (
          <ComposeBlock
            // A fresh composer per successful launch — see launchSeq.
            key={launchSeq}
            client={client}
            taskId={taskId}
            flushTask={flushTask}
            availability={availability}
            loadingMachines={machinesQuery.isPending}
            primaryLabel={visible.length === 0 ? "Delegate" : "Add agent"}
            onDelegated={() => {
              setComposeOverride(null);
              setLaunchSeq((n) => n + 1);
            }}
          />
        )}

        {/* The two doors, at equal weight. Collapsed, they sit side by side;
            expanded, only the link door remains — the composer IS the other one,
            already on screen. Linking must stay reachable in both states: a
            machine whose chats Hitch has never launched has an empty lane, which
            is exactly when compose is expanded. */}
        <div className="flex items-center gap-1">
          {!composeExpanded && (
            <>
              <button
                type="button"
                onClick={() => setComposeOverride(true)}
                className="flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-[#555555] hover:bg-black/5 dark:text-muted-foreground dark:hover:bg-white/5"
              >
                <PlusIcon className="size-3.5" aria-hidden />
                Add an agent
              </button>
              <span
                aria-hidden
                className="mx-1.5 h-3.5 w-px shrink-0 bg-[#DEDEDE] dark:bg-border"
              />
            </>
          )}
          <LinkChatPicker
            client={client}
            taskId={taskId}
            projectId={projectId}
            chats={chatsQuery.data}
            loading={chatsQuery.isPending}
            onError={setLinkError}
            onLinked={() => {
              setComposeOverride(null);
              setLinkError(null);
            }}
          />
        </div>

        {/* The link failure. The server writes real prose for the conflicts (a
            chat already on another task, a stop still in flight), so this is its
            sentence verbatim — see routes/assignments.ts. */}
        {linkError && (
          <p className="text-[12px] text-destructive">{linkError}</p>
        )}
      </div>
    </div>
  );
}
