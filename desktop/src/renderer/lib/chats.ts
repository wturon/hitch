import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { ChatStatus, Environment, Harness } from "@/lib/chat";
import { harnessLabel } from "@/lib/chat";

export type StoredChatStatus = ChatStatus | "idle";
export type ChatDisplayStatus = "working" | "needs-input" | "idle";
export type ChatLinkedType = "task" | "note" | "automation";
export type ChatResumeKind = "open-chat-command" | "external";

// The raw chat doc as Convex queries return it — anchored to getChatByLink (the
// one remaining chat-doc query) so the view-model stays typed against the wire
// shape.
export type ChatRecord = NonNullable<
  FunctionReturnType<typeof api.chats.getChatByLink>
>;

export interface ChatRowViewModel {
  id: Id<"chats">;
  launchId?: string;
  harness: Harness;
  harnessLabel: string;
  chatId?: string;
  pending: boolean;
  status: StoredChatStatus;
  displayStatus: ChatDisplayStatus;
  statusLabel: string;
  running: boolean;
  needsInput: boolean;
  title: string;
  cwd: string;
  host: string;
  environment?: Environment;
  linkedType?: ChatLinkedType;
  linkedPath?: string;
  resumeKind: ChatResumeKind;
  resumePayload?: unknown;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  firstObservedAt: number;
  lastEventAt: number;
  lastStatusAt: number;
  updatedAt: number;
  sortTime: number;
}

export interface StartStandaloneChatInput {
  projectId: Id<"projects">;
  harness: Harness;
  initialPrompt: string;
  title?: string;
  cwd?: string;
  host?: string;
  model?: string;
  effort?: string;
}

export interface StartLinkedChatInput extends StartStandaloneChatInput {
  linkedType: ChatLinkedType;
  linkedPath: string;
}

export type StartChatInput = StartStandaloneChatInput | StartLinkedChatInput;

export interface ChatMutationInput {
  projectId: Id<"projects">;
  id: Id<"chats">;
}

export function chatDisplayStatus(status: StoredChatStatus): ChatDisplayStatus {
  if (status === "working") return "working";
  if (status === "needs-input") return "needs-input";
  return "idle";
}

export function chatStatusLabel(status: StoredChatStatus): string {
  switch (chatDisplayStatus(status)) {
    case "working":
      return "working";
    case "needs-input":
      return "needs input";
    case "idle":
      return "idle";
  }
}

export function isChatRunning(status: StoredChatStatus): boolean {
  return status === "working";
}

export function chatSortTime(chat: Pick<ChatRecord, "lastEventAt" | "updatedAt">) {
  return Math.max(chat.lastEventAt, chat.updatedAt);
}

export function chatRowViewModel(chat: ChatRecord): ChatRowViewModel {
  return {
    id: chat._id,
    launchId: chat.launchId,
    harness: chat.harness,
    harnessLabel: harnessLabel(chat.harness),
    chatId: chat.chatId,
    pending: chat.pending,
    status: chat.status,
    displayStatus: chatDisplayStatus(chat.status),
    statusLabel: chatStatusLabel(chat.status),
    running: isChatRunning(chat.status),
    needsInput: chat.status === "needs-input",
    title: chat.title,
    cwd: chat.cwd,
    host: chat.host,
    environment: chat.environment,
    linkedType: chat.linkedType,
    linkedPath: chat.linkedPath,
    resumeKind: chat.resumeKind,
    resumePayload: chat.resumePayload,
    pinned: chat.pinned === true,
    archived: chat.archivedAt !== undefined,
    deleted: chat.deletedAt !== undefined,
    firstObservedAt: chat.firstObservedAt,
    lastEventAt: chat.lastEventAt,
    lastStatusAt: chat.lastStatusAt,
    updatedAt: chat.updatedAt,
    sortTime: chatSortTime(chat),
  };
}
