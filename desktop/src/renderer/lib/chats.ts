import type { Id } from "@convex/_generated/dataModel";
import type { Harness } from "@/lib/chat";

export type ChatLinkedType = "task" | "automation";

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
