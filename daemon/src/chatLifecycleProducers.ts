import type {
  ChatLifecycleEventInput,
  ChatLifecycleHarness,
  ChatLifecycleProducer,
  ChatLifecycleStatus,
  ChatLifecycleStore,
} from "./chatLifecycleStore.js";

export interface DaemonLifecycleProducerOptions {
  store: ChatLifecycleStore;
  projectId: string;
  projectLocalPath: string;
  host: string;
  now?: () => number;
}

export interface DaemonLifecycleEventBase {
  commandId?: string;
  launchId?: string | null;
  automationRunId?: string | null;
  harness: ChatLifecycleHarness;
  environment?: string | null;
  cwd: string;
  linkedPath?: string | null;
}

export interface DaemonChatCreatedInput extends DaemonLifecycleEventBase {
  title?: string | null;
}

export interface DaemonChatBoundInput extends DaemonLifecycleEventBase {
  chatId: string;
}

export interface DaemonTurnCompletedInput extends DaemonLifecycleEventBase {
  chatId: string;
  title?: string | null;
}

export interface DaemonSessionEndedInput extends DaemonLifecycleEventBase {
  chatId: string;
  pid?: number | null;
}

export interface DaemonLifecycleInsertResult {
  inserted: boolean;
  seq: number | null;
}

function fallbackLaunchId(commandId: string | undefined): string | null {
  return commandId ? `command:${commandId}` : null;
}

function launchId(input: DaemonLifecycleEventBase): string | null {
  return input.launchId ?? fallbackLaunchId(input.commandId);
}

function linkedType(
  path: string | null | undefined,
): "task" | "automation" | null {
  if (!path) return null;
  if (path.startsWith("tasks/")) return "task";
  if (path.startsWith("automations/")) return "automation";
  return null;
}

function eventId(
  projectId: string,
  producer: ChatLifecycleProducer,
  providerEvent: string,
  parts: Array<string | number | null | undefined>,
): string {
  return [
    "daemon",
    projectId,
    producer,
    providerEvent,
    ...parts.map((part) => String(part ?? "none")),
  ].join(":");
}

export class DaemonLifecycleProducer {
  private readonly store: ChatLifecycleStore;
  private readonly projectId: string;
  private readonly projectLocalPath: string;
  private readonly host: string;
  private readonly now: () => number;

  constructor(options: DaemonLifecycleProducerOptions) {
    this.store = options.store;
    this.projectId = options.projectId;
    this.projectLocalPath = options.projectLocalPath;
    this.host = options.host;
    this.now = options.now ?? Date.now;
  }

  chatCreated(input: DaemonChatCreatedInput): DaemonLifecycleInsertResult {
    return this.insert({
      input,
      producer: "daemon-launch",
      providerEvent: "start-chat",
      lifecycle: "chat.created",
      status: "working",
      chatId: null,
      eventParts: [input.launchId ?? input.commandId],
      metadata: {
        commandId: input.commandId ?? null,
        launchId: input.launchId ?? null,
        automationRunId: input.automationRunId ?? null,
        environment: input.environment ?? null,
        linkedType: linkedType(input.linkedPath),
        linkedPath: input.linkedPath ?? null,
        title: input.title ?? null,
      },
    });
  }

  chatBound(input: DaemonChatBoundInput): DaemonLifecycleInsertResult {
    return this.insert({
      input,
      producer: "daemon-linker",
      providerEvent: "chat.bound",
      lifecycle: "chat.bound",
      status: "working",
      chatId: input.chatId,
      eventParts: [input.launchId ?? input.commandId, input.chatId],
      metadata: {
        commandId: input.commandId ?? null,
        launchId: input.launchId ?? null,
        automationRunId: input.automationRunId ?? null,
        environment: input.environment ?? null,
        linkedType: linkedType(input.linkedPath),
        linkedPath: input.linkedPath ?? null,
      },
    });
  }

  turnCompleted(input: DaemonTurnCompletedInput): DaemonLifecycleInsertResult {
    return this.insert({
      input,
      producer: "daemon-appserver",
      providerEvent: "turn.completed",
      lifecycle: "turn.completed",
      status: "waiting",
      chatId: input.chatId,
      eventParts: [input.launchId ?? input.commandId, input.chatId],
      metadata: {
        commandId: input.commandId ?? null,
        launchId: input.launchId ?? null,
        automationRunId: input.automationRunId ?? null,
        environment: input.environment ?? null,
        linkedType: linkedType(input.linkedPath),
        linkedPath: input.linkedPath ?? null,
        title: input.title ?? null,
      },
    });
  }

  sessionEnded(input: DaemonSessionEndedInput): DaemonLifecycleInsertResult {
    return this.insert({
      input,
      producer: "daemon-reconcile",
      providerEvent: "session.ended",
      lifecycle: "session.ended",
      status: null,
      chatId: input.chatId,
      eventParts: [input.chatId, input.pid ?? null],
      metadata: {
        commandId: input.commandId ?? null,
        launchId: input.launchId ?? null,
        automationRunId: input.automationRunId ?? null,
        environment: input.environment ?? null,
        linkedType: linkedType(input.linkedPath),
        linkedPath: input.linkedPath ?? null,
        pid: input.pid ?? null,
      },
    });
  }

  private insert({
    input,
    producer,
    providerEvent,
    lifecycle,
    status,
    chatId,
    eventParts,
    metadata,
  }: {
    input: DaemonLifecycleEventBase;
    producer: ChatLifecycleProducer;
    providerEvent: string;
    lifecycle: ChatLifecycleEventInput["lifecycle"];
    status: ChatLifecycleStatus | null;
    chatId: string | null;
    eventParts: Array<string | number | null | undefined>;
    metadata: Record<string, unknown>;
  }): DaemonLifecycleInsertResult {
    const observedAt = this.now();
    return this.store.insertLifecycleEvent({
      eventId: eventId(this.projectId, producer, providerEvent, [
        input.harness,
        ...eventParts,
      ]),
      source: "daemon",
      producer,
      harness: input.harness,
      providerEvent,
      lifecycle,
      status,
      projectId: this.projectId,
      projectLocalPath: this.projectLocalPath,
      chatId,
      launchId: launchId(input),
      turnId: null,
      cwd: input.cwd,
      host: this.host,
      observedAt,
      rawPayloadHash: null,
      rawPayloadRef: null,
      metadata,
    });
  }
}
