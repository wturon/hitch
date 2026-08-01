"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LinkIcon, LoaderCircle } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HarnessIcon } from "@/components/HarnessIcon";
import type { HitchClient } from "@/lib/server/client";
import { cn } from "@/lib/utils";
import { iconHarness } from "./delegation";
import {
  chatLocationLine,
  chatSearchValue,
  chatStatusWord,
  linkableChats,
  type LinkableChat,
} from "./linkableChats";
import type { ChatRow } from "./useAssignments";

// "Link a chat" — the delegate band's second door.
//
// Delegating CREATES a chat; this ADOPTS one that already exists on the machine.
// The two are peers, which is why this sits beside "＋ Add an agent" at the same
// weight rather than behind an overflow menu: every new environment can observe
// its chats long before it can spawn them, and until linking was its own action
// a task could only acknowledge work Hitch itself had started.
//
// The whole write is POST /assignments/link, which was already here for the CLI
// (`hitch tasks link`). It records `requested_chat_id` as intent; the DAEMON
// remains the only writer of the authoritative `chat_id`, so this component
// never sees or sets one — the lane fills in a beat later when the reconciler
// echoes the attachment back.
//
// Which chats are offered, in what order, and how each reads is linkableChats'
// job — this file is the surface and the mutation.

export interface LinkChatPickerProps {
  client: HitchClient;
  taskId: string;
  /** The task's project, for the "In this project" grouping. */
  projectId: string | null;
  /** GET /chats (live). `undefined` until the first read lands. */
  chats: readonly ChatRow[] | undefined;
  loading: boolean;
  /**
   * Where the failure goes. Lifted to the band so the message survives the
   * popover closing — a 409 explaining that the chat serves another task is
   * useless if it dies with the surface that triggered it.
   */
  onError: (message: string | null) => void;
  /** A successful link — the band refetches and folds compose away. */
  onLinked: () => void;
}

export function LinkChatPicker({
  client,
  taskId,
  projectId,
  chats,
  loading,
  onError,
  onLinked,
}: LinkChatPickerProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const groups = linkableChats(chats, { taskId, projectId });

  const link = useCallback(
    async (chat: ChatRow) => {
      // Guarded by the row being enabled, but the type is nullable and a
      // sessionless row has nothing to address.
      if (chat.sessionId === null) return;
      setLinkingId(chat.id);
      onError(null);
      try {
        const response = await client.assignments.link.$post({
          json: {
            taskId,
            harness: chat.harness,
            sessionId: chat.sessionId,
            // We picked a ROW, so we know the machine: this turns the route's
            // "ambiguous across machines" 409 into a case that cannot arise.
            machineId: chat.machineId,
          },
        });
        if (!response.ok) {
          // The route writes real prose for the conflicts (a chat already on
          // another task, a stop still in flight). Prefer it verbatim over a
          // status code — it is more specific than anything this file knows.
          const body = (await response.json().catch(() => null)) as
            | { error?: unknown }
            | null;
          const message =
            typeof body?.error === "string" && body.error.trim() !== ""
              ? body.error
              : `Couldn’t link that chat (${response.status}).`;
          onError(message);
          return;
        }
        // Both, and not just because the WS frame will say so a moment later:
        // the lane reads assignments, and the PICKER reads chats — whose
        // committed-task field just changed for the row we clicked. Waiting on
        // the round trip would leave the chat offered a second time.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["assignments"] }),
          queryClient.invalidateQueries({ queryKey: ["chats"] }),
        ]);
        setOpen(false);
        onLinked();
      } catch (error) {
        console.error("Failed to link chat", error);
        onError("Couldn’t reach the server to link that chat.");
      } finally {
        setLinkingId(null);
      }
    },
    [client, onError, onLinked, queryClient, taskId],
  );

  const rows = (entries: readonly LinkableChat<ChatRow>[]) =>
    entries.map(({ chat, disabledReason }) => {
      const status = chatStatusWord(chat);
      const busy = linkingId === chat.id;
      return (
        <CommandItem
          key={chat.id}
          value={chatSearchValue(chat)}
          disabled={disabledReason !== null || linkingId !== null}
          onSelect={() => {
            if (disabledReason !== null || linkingId !== null) return;
            void link(chat);
          }}
          className="gap-2.5 px-2 py-1.5"
        >
          {/* The harness mark, with the one amber dot a row is allowed. */}
          <span className="relative flex size-[22px] shrink-0 items-center justify-center rounded-full border border-[#DEDEDE] bg-background dark:border-border">
            <HarnessIcon harness={iconHarness(chat.harness)} className="size-3" />
            {status.needsYou && (
              <span
                aria-hidden
                className="absolute -top-px -right-px size-[7px] rounded-full border-[1.5px] border-background bg-[#F59E0B]"
              />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-foreground">
              {chat.title}
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground">
              {chatLocationLine(chat)}
            </span>
          </span>
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              disabledReason
            )}
          </span>
        </CommandItem>
      );
    });

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        // Opening is a fresh attempt: clear the last failure rather than
        // leaving a stale 409 under a list the user is about to re-pick from.
        if (next) onError(null);
      }}
    >
      <PopoverTrigger className="flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-[#555555] hover:bg-black/5 dark:text-muted-foreground dark:hover:bg-white/5">
        <LinkIcon className="size-3.5" aria-hidden />
        Link a chat
      </PopoverTrigger>
      <PopoverContent className="w-[452px] p-0">
        <Command shouldFilter loop>
          <CommandInput
            autoFocus
            placeholder="Search chats on this machine…"
            className="h-9 text-[13px]"
          />
          <CommandList className="max-h-[316px] p-1">
            <CommandEmpty className="px-4 py-6 text-center">
              <span className="block text-[13px] font-medium text-foreground">
                {loading ? "Looking for chats…" : "No chats to link"}
              </span>
              {!loading && (
                <span className="mx-auto mt-1 block max-w-[34ch] text-[12px] leading-[19px] text-muted-foreground">
                  {groups.total === 0
                    ? "Hitch sees no live claude or codex sessions on this machine right now."
                    : "No chat matches that search."}
                </span>
              )}
            </CommandEmpty>
            {groups.inProject.length > 0 && (
              <CommandGroup heading="In this project">
                {rows(groups.inProject)}
              </CommandGroup>
            )}
            {groups.elsewhere.length > 0 && (
              <CommandGroup
                heading={groups.inProject.length > 0 ? "Elsewhere" : "On this machine"}
              >
                {rows(groups.elsewhere)}
              </CommandGroup>
            )}
          </CommandList>
          {/* One calm sentence for the asymmetry the lane can only hint at: an
              adopted chat is fully observable, but Hitch didn't start it and
              can't drive it. Better said once here than repeated per row. */}
          <p
            className={cn(
              "border-t border-border px-3 py-2 text-[11.5px] leading-[17px] text-muted-foreground",
              groups.total === 0 && "hidden",
            )}
          >
            Linking adopts the chat where it already runs. Nothing is sent to it.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
