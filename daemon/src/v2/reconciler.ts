// V2 reconciler core (M4 PR 3).
//
// The daemon is a pure reconciler (PRD): it diffs the server's DESIRED state
// against machine GROUND TRUTH and executes spawn/close/observe, writing ONLY
// observations back. It never invents business rules — close-on-done is CLIENT
// intent (Decision 3); the reconciler only carries out `desired_state`.
//
// Two forms, never a stored command (PRD): assignments rows are the truth; the
// WS `assignments` invalidate is just "look now". A ~30s tick is the fallback,
// and a reconnect re-reconciles from scratch. Passes are serialized (one at a
// time) with a trailing re-run flag so a trigger mid-pass isn't lost.
//
// Single-creator rule: chats are DAEMON-created. The reconciler creates the
// local chat-store row (so the harness hooks + observer fold status into it),
// POSTs the server `chats` row, and links the assignment to it — all before the
// harness actually launches, so a mid-flight restart re-diffs safely (the
// observable state was already written).
//
// V1 is imported, never edited: cmux.ts / launchers wrap the real spawn/close;
// chatLifecycleStore is the shared local truth (the same sqlite the hooks and
// the observer write). The reconciler reads store rows the relay loop keeps
// reduced and never reduces the event log itself (single reducer = the relay).

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type {
  ChatLifecycleStore,
  ChatLifecycleStatus,
} from "../chatLifecycleStore.js";
import { CmuxError } from "../cmux.js";
import { resolveLauncher as registryResolveLauncher } from "../launchers/registry.js";
import type { Environment, Harness, Launcher } from "../launchers/types.js";
import type { HitchClient } from "./serverClient.js";

// The registry's resolveLauncher shape. Injectable (defaults to the registry) so
// the fake-launch seam (M4 PR 4) can swap in cmux-less stand-ins without touching
// any launcher-resolution call site here — zero behavior change when unset.
export type LauncherResolver = (
  harness: Harness,
  environment?: Environment,
) => Launcher | undefined;

// Wire row shapes. The shared @hitch/shared row types are the Drizzle
// $inferSelect shapes whose timestamp fields are Date; over the wire (JSON)
// those cross as ISO strings, so we read the minimal subset we need with the
// honest string types rather than casting the whole Date-typed row.
interface WireAssignment {
  id: string;
  taskId: string;
  machineId: string;
  harness: ServerHarness;
  prompt: string | null;
  // Kickoff-only launch params chosen client-side; null → harness default
  // (the launcher's argv defaults stand, i.e. today's behavior).
  model: string | null;
  effort: string | null;
  desiredState: DesiredState;
  observedState: ObservedState;
  chatId: string | null;
}
interface WireChat {
  id: string;
  cmuxRef: unknown;
  status: ServerChatStatus;
}
interface WireTask {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
}
interface WireProject {
  id: string;
  name: string;
  repoPath: string | null;
}

// The cmux_ref jsonb we write. Matches z.json()'s recursive value type so the
// typed hono client accepts it without a cast (mirrors chatSync's JsonObject).
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

// ─── Wire vocabulary (mirror of the server pgEnums) ──────────────────────────

export type DesiredState = "running" | "stopped";
export type ObservedState =
  | "pending"
  | "spawning"
  | "running"
  | "waiting_input"
  | "done"
  | "dead";
export type ServerHarness = "claude" | "codex";
export type ServerChatStatus = "busy" | "waiting_input" | "idle" | "dead";

export interface ReconcilerLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

// ─── Pure decision logic (unit-tested in v2-reconciler-smoke) ────────────────

// The action the reconciler takes for one assignment, given desired vs observed
// and whether a chat is linked. Pure — the diff table lives here, testable
// without a server or cmux.
export type ReconcileDecision = "spawn" | "close" | "mark-done" | "observe" | "noop";

export interface AssignmentSnapshot {
  desiredState: DesiredState;
  observedState: ObservedState;
  hasChat: boolean;
}

export function decideAction(a: AssignmentSnapshot): ReconcileDecision {
  if (a.desiredState === "stopped") {
    // Terminal already — nothing to execute.
    if (a.observedState === "done" || a.observedState === "dead") return "noop";
    // Never spawned (no tab to close) → mark done directly.
    if (a.observedState === "pending") return "mark-done";
    // spawning | running | waiting_input: close the live chat, else just settle.
    return a.hasChat ? "close" : "mark-done";
  }

  // desired = running
  if (a.observedState === "done" || a.observedState === "dead") return "noop";
  // Not acted on yet and no chat → claim + spawn. (A pending row that somehow
  // already carries a chat is observed, not re-spawned.)
  if (a.observedState === "pending") return a.hasChat ? "observe" : "spawn";
  // spawning | running | waiting_input: keep deriving observations from the chat.
  return a.hasChat ? "observe" : "noop";
}

// Map the linked chat's CURRENT local-store state to an observed_state, or null
// when no transition should be forced. Mirrors the plan's state mapping:
//   busy (working)                 → running
//   waiting_input (waiting/needs)  → waiting_input   ("agent finished a pass")
//   dead (endedAt set)             → done            (it spawned and ended)
//   store row missing entirely     → dead            (launch never bound)
// A live-idle chat (no endedAt, gone/dormant but unconfirmed) is ambiguous, so
// it returns null — the reconciler waits for endedAt or a real status change
// rather than declaring done prematurely.
export function deriveObserved(
  chat: { status: ChatLifecycleStatus; endedAt: number | null } | null,
): ObservedState | null {
  if (chat === null) return "dead";
  if (chat.endedAt !== null) return "done";
  switch (chat.status) {
    case "working":
      return "running";
    case "needs-input":
    case "waiting":
      return "waiting_input";
    case "idle":
      return null;
  }
}

// Transition-only PATCH gate: return the next state to write, or null to skip
// (unchanged, or no observation to force). Keeps us from re-PATCHing the same
// observed_state every tick.
export function observationTransition(
  current: ObservedState,
  derived: ObservedState | null,
): ObservedState | null {
  if (derived === null) return null;
  return derived === current ? null : derived;
}

// ─── Prompt preamble (Decision 2) ────────────────────────────────────────────
//
// Ported VERBATIM from desktop/src/renderer/v2/delegation.ts (buildDelegatePreamble)
// so the two sides agree on wording: when the client stamped assignments.prompt
// the daemon uses it as-is; when prompt is null the daemon builds THIS preamble.
// Keep the wording identical to the desktop builder.

export interface DelegateTask {
  id: string;
  title: string;
  body: string;
}

export function buildDelegatePreamble(task: DelegateTask): string {
  const hasBody = task.body.trim() !== "";
  return [
    `You're picking up the Hitch task "${task.title}".`,
    "",
    "Here is the full task description, verbatim:",
    "",
    hasBody ? task.body : "(No description was written.)",
    "",
    `Task id: ${task.id}`,
    "If the `hitch` CLI is installed, you can use it to read this task, add" +
      " comments, and mark it complete — run `hitch --help` to see how.",
  ].join("\n");
}

// ─── Reconciler ──────────────────────────────────────────────────────────────

export interface ReconcilerOptions {
  client: HitchClient;
  store: ChatLifecycleStore;
  machineId: string;
  host: string;
  logger: ReconcilerLogger;
  /** Fallback reconcile cadence; parallels the heartbeat tick. Default 30_000. */
  tickMs?: number;
  now?: () => number;
  /**
   * Launcher resolver. Defaults to the real registry; the fake-launch daemon
   * (HITCH_FAKE_LAUNCH=1) passes a cmux-less resolver here. When omitted the
   * behavior is identical to calling the registry directly.
   */
  resolveLauncher?: LauncherResolver;
}

const DEFAULT_TICK_MS = 30_000;

// The free-form jsonb we stash on the server chat so the observation loop (and a
// later focus relay) can re-address it. Carries the local key we look the store
// row up by, plus the session id once known.
interface CmuxRef {
  localKey: string;
  sessionId: string | null;
  launchId: string | null;
  cwd: string;
  host: string;
  environment: string;
  resumeKind: string;
}

// Map the server harness enum to the store/launcher harness vocabulary.
function storeHarness(harness: ServerHarness): Harness {
  return harness === "codex" ? "codex" : "claude-code";
}

export class Reconciler {
  private readonly client: HitchClient;
  private readonly store: ChatLifecycleStore;
  private readonly machineId: string;
  private readonly host: string;
  private readonly logger: ReconcilerLogger;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly resolveLauncher: LauncherResolver;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;
  // Assignments with a spawn/close in flight this process lifetime. Guards
  // double-spawn between the claim and the "spawning" write landing on the
  // server (a restart re-diffs safely because the observable state is written
  // before the harness launches).
  private readonly inFlight = new Set<string>();

  constructor(options: ReconcilerOptions) {
    this.client = options.client;
    this.store = options.store;
    this.machineId = options.machineId;
    this.host = options.host;
    this.logger = options.logger;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.now = options.now ?? Date.now;
    this.resolveLauncher = options.resolveLauncher ?? registryResolveLauncher;
  }

  // Start the fallback tick and run an initial pass.
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.trigger("tick"), this.tickMs);
    this.timer.unref?.();
    this.trigger("startup");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Request a reconcile pass. Serializes: if one is running, sets the trailing
  // re-run flag so the trigger isn't lost.
  trigger(reason: string): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.runPasses(reason);
  }

  private async runPasses(reason: string): Promise<void> {
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.reconcileOnce(reason).catch((error) => {
          this.logger.error?.(`[hitch] reconcile pass (${reason}) failed: ${String(error)}`);
        });
      } while (this.rerun && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async reconcileOnce(reason: string): Promise<void> {
    const assignments = await this.fetchMachineAssignments();
    if (!assignments) return;
    if (assignments.length === 0) return;
    const chatsById = await this.fetchMachineChats();

    for (const a of assignments) {
      if (this.stopped) return;
      const decision = decideAction({
        desiredState: a.desiredState as DesiredState,
        observedState: a.observedState as ObservedState,
        hasChat: a.chatId != null,
      });
      switch (decision) {
        case "spawn":
          this.claimAndSpawn(a);
          break;
        case "close":
          this.claimAndClose(a, chatsById);
          break;
        case "mark-done":
          await this.patchObservedIfChanged(a, "done");
          break;
        case "observe":
          await this.observe(a, chatsById);
          break;
        case "noop":
          break;
      }
    }
    if (reason === "startup") {
      this.logger.info(`[hitch] reconciler: first pass over ${assignments.length} assignment(s)`);
    }
  }

  // ─── Fetch (filter to THIS machine client-side) ────────────────────────────

  private async fetchMachineAssignments(): Promise<WireAssignment[] | null> {
    try {
      const res = await this.client.assignments.$get({ query: {} });
      if (!res.ok) {
        this.logger.error?.(`[hitch] GET /assignments failed (${res.status})`);
        return null;
      }
      const rows = (await res.json()) as WireAssignment[];
      return rows.filter((a) => a.machineId === this.machineId);
    } catch (error) {
      this.logger.error?.(`[hitch] GET /assignments error: ${String(error)}`);
      return null;
    }
  }

  private async fetchMachineChats(): Promise<Map<string, WireChat>> {
    const byId = new Map<string, WireChat>();
    try {
      const res = await this.client.daemon.chats.$get({
        query: { machine_id: this.machineId },
      });
      if (!res.ok) {
        this.logger.error?.(`[hitch] GET /daemon/chats failed (${res.status})`);
        return byId;
      }
      for (const chat of (await res.json()) as WireChat[]) byId.set(chat.id, chat);
    } catch (error) {
      this.logger.error?.(`[hitch] GET /daemon/chats error: ${String(error)}`);
    }
    return byId;
  }

  // ─── Spawn ─────────────────────────────────────────────────────────────────

  private claimAndSpawn(a: WireAssignment): void {
    if (this.inFlight.has(a.id)) return;
    this.inFlight.add(a.id);
    void this.spawn(a)
      .catch(async (error) => {
        const code = error instanceof CmuxError ? ` [${error.code}]` : "";
        this.logger.error?.(
          `[hitch] reconciler spawn failed for assignment ${a.id}${code}: ${String(error)}`,
        );
        // Launch failure / cmux unreachable → dead (never bound), per the plan's
        // asymmetry (ended-after-spawn is done; launch failure is dead).
        await this.patchObserved(a.id, "dead").catch(() => {});
      })
      .finally(() => this.inFlight.delete(a.id));
  }

  private async spawn(a: WireAssignment): Promise<void> {
    const task = await this.getTask(a.taskId);
    const project = task.projectId ? await this.getProject(task.projectId) : null;
    const repoPath = project?.repoPath?.trim();
    // Decision 4: spawn cwd = project.repoPath ?? homedir().
    const cwd = repoPath && repoPath.length > 0 ? repoPath : homedir();
    // Decision 2: assignments.prompt verbatim, else the default preamble.
    const prompt =
      a.prompt != null ? a.prompt : buildDelegatePreamble({ id: task.id, title: task.title, body: task.body });
    const serverHarness = (a.harness as ServerHarness) ?? "claude";
    const harness = storeHarness(serverHarness);
    // Kickoff-only launch params. null/undefined → undefined so the launcher
    // uses the harness default (StartCtx.model/effort are optional). V2 always
    // spawns into cmux, which honors both, so no param-honoring gate is needed.
    const model = a.model ?? undefined;
    const effort = a.effort ?? undefined;
    const environment: Environment = "cmux"; // Decision 5: always cmux for V2.
    const launcher = this.resolveLauncher(harness, environment);
    if (!launcher?.startNew) {
      throw new Error(`no ${harness}/${environment} launcher with startNew`);
    }
    const title = task.title;
    const launchId = randomUUID();
    const projectRef = {
      projectId: task.projectId ?? this.machineId,
      projectName: project?.name ?? title,
    };
    const taskKey = `assignment:${a.id}`;

    if (serverHarness === "codex") {
      // Codex learns its thread id only mid-launch, so create+link UP FRONT
      // keyed by the launch, then let the bind rekey the row when the hook fires.
      const now = this.now();
      const launchKey = `launch:${launchId}`;
      this.upsertChatRow({
        localKey: launchKey,
        projectId: task.projectId,
        launchId,
        harness,
        chatId: null,
        pending: true,
        title,
        cwd,
        resumePayload: { launchId, cwd },
        now,
      });
      const serverChatId = await this.postChat({
        projectId: task.projectId,
        harness: serverHarness,
        title,
        cmuxRef: this.cmuxRef(launchKey, null, launchId, cwd),
        now,
      });
      this.store.markChatServerSynced(launchKey, { serverChatId, syncedAt: now });
      await this.patchAssignment(a.id, { chatId: serverChatId, observedState: "spawning" });
      this.logger.info(
        `[hitch] reconciler spawning codex for assignment ${a.id} (chat ${serverChatId})`,
      );
      await launcher.startNew({
        launchId,
        taskKey,
        prompt,
        cwd,
        title,
        model,
        effort,
        project: projectRef,
        logger: this.logger,
        onLinked: async (threadId) => {
          const boundNow = this.now();
          const chatKey = `chat:codex:${this.host}:${threadId}`;
          // Upsert the bound row: upsertLocalChat rekeys the launch row (which
          // still holds this launchId) to the chat key, preserving server_chat_id.
          this.upsertChatRow({
            localKey: chatKey,
            projectId: task.projectId,
            launchId,
            harness,
            chatId: threadId,
            pending: false,
            title,
            cwd,
            resumePayload: { launchId, chatId: threadId, cwd },
            now: boundNow,
          });
          // Update the server chat's cmux_ref with the now-known thread id.
          await this.client.daemon.chats[":id"]
            .$patch({
              param: { id: serverChatId },
              json: { cmuxRef: this.cmuxRef(chatKey, threadId, launchId, cwd), status: "busy" },
            })
            .catch(() => {});
        },
      });
      return;
    }

    // Claude pins its session id up front (claude --session-id). The launcher
    // fires onLinked with that id BEFORE the cmux send, so create+link there —
    // if it throws, the launcher never spawns and we fall to `dead`.
    await launcher.startNew({
      launchId,
      taskKey,
      prompt,
      cwd,
      title,
      model,
      effort,
      project: projectRef,
      logger: this.logger,
      onLinked: async (sessionId) => {
        const now = this.now();
        const localKey = `chat:claude-code:${this.host}:${sessionId}`;
        this.upsertChatRow({
          localKey,
          projectId: task.projectId,
          launchId: null,
          harness,
          chatId: sessionId,
          pending: false,
          title,
          cwd,
          resumePayload: { chatId: sessionId, cwd },
          now,
        });
        const serverChatId = await this.postChat({
          projectId: task.projectId,
          harness: serverHarness,
          title,
          cmuxRef: this.cmuxRef(localKey, sessionId, null, cwd),
          now,
        });
        this.store.markChatServerSynced(localKey, { serverChatId, syncedAt: now });
        await this.patchAssignment(a.id, { chatId: serverChatId, observedState: "spawning" });
        this.logger.info(
          `[hitch] reconciler spawning claude for assignment ${a.id} ` +
            `(chat ${serverChatId}, session ${sessionId.slice(0, 8)})`,
        );
      },
    });
  }

  // ─── Close (Decision 3: execute desired=stopped) ──────────────────────────

  private claimAndClose(a: WireAssignment, chatsById: Map<string, WireChat>): void {
    if (this.inFlight.has(a.id)) return;
    this.inFlight.add(a.id);
    void this.close(a, chatsById)
      .catch((error) => {
        this.logger.error?.(`[hitch] reconciler close failed for assignment ${a.id}: ${String(error)}`);
      })
      .finally(() => this.inFlight.delete(a.id));
  }

  private async close(a: WireAssignment, chatsById: Map<string, WireChat>): Promise<void> {
    const row = this.resolveStoreRow(a, chatsById);
    const sessionId = row?.chatId ?? this.sessionIdFromChat(a, chatsById);
    const harness = storeHarness((a.harness as ServerHarness) ?? "claude");
    const launcher = this.resolveLauncher(harness, "cmux");
    if (sessionId && launcher?.close) {
      await launcher.close({
        sessionId,
        project: { projectId: a.chatId ?? this.machineId, projectName: "" },
      });
      this.logger.info(`[hitch] reconciler closed chat for assignment ${a.id}`);
    } else {
      // Nothing bound to close (codex that never reported a thread, etc.) — the
      // goal state (no live tab) already holds; just settle.
      this.logger.info(`[hitch] reconciler: no live chat to close for assignment ${a.id}`);
    }
    await this.patchObserved(a.id, "done");
  }

  // ─── Observe (transition-only PATCHes) ────────────────────────────────────

  private async observe(a: WireAssignment, chatsById: Map<string, WireChat>): Promise<void> {
    const serverChat = a.chatId ? chatsById.get(a.chatId) ?? null : null;
    const row = this.resolveStoreRow(a, chatsById);
    if (!row) {
      // Store row missing. Only conclude `dead` when the server chat is also
      // gone/dead — this guards the codex bind window where cmux_ref.localKey
      // briefly lags the rekey and the launch row has already moved.
      if (!serverChat || (serverChat.status as ServerChatStatus) === "dead") {
        await this.patchObservedIfChanged(a, "dead");
      }
      return;
    }
    const derived = deriveObserved({ status: row.status, endedAt: row.endedAt });
    const next = observationTransition(a.observedState as ObservedState, derived);
    if (next) await this.patchObserved(a.id, next);
  }

  // ─── Store-row resolution ──────────────────────────────────────────────────

  // The local chat-store row backing an assignment's chat. We reach it via the
  // server chat's cmux_ref.localKey (persistent, and what chatSync keeps fresh),
  // falling back to reconstructing the key from harness+host+sessionId.
  private resolveStoreRow(a: WireAssignment, chatsById: Map<string, WireChat>) {
    if (!a.chatId) return null;
    const serverChat = chatsById.get(a.chatId);
    if (!serverChat) return null;
    const ref = (serverChat.cmuxRef ?? {}) as Partial<CmuxRef>;
    if (typeof ref.localKey === "string") {
      const byKey = this.store.getLocalChat(ref.localKey);
      if (byKey) return byKey;
    }
    if (typeof ref.sessionId === "string") {
      const harness = storeHarness((a.harness as ServerHarness) ?? "claude");
      const byChat = this.store.getLocalChat(`chat:${harness}:${this.host}:${ref.sessionId}`);
      if (byChat) return byChat;
    }
    return null;
  }

  private sessionIdFromChat(a: WireAssignment, chatsById: Map<string, WireChat>): string | null {
    if (!a.chatId) return null;
    const ref = (chatsById.get(a.chatId)?.cmuxRef ?? {}) as Partial<CmuxRef>;
    return typeof ref.sessionId === "string" ? ref.sessionId : null;
  }

  // ─── Server + store helpers ────────────────────────────────────────────────

  private cmuxRef(
    localKey: string,
    sessionId: string | null,
    launchId: string | null,
    cwd: string,
  ): JsonObject {
    return {
      localKey,
      sessionId,
      launchId,
      cwd,
      host: this.host,
      environment: "cmux",
      resumeKind: "open-chat-command",
    };
  }

  private upsertChatRow(input: {
    localKey: string;
    projectId: string | null;
    launchId: string | null;
    harness: Harness;
    chatId: string | null;
    pending: boolean;
    title: string;
    cwd: string;
    resumePayload: Record<string, unknown>;
    now: number;
  }): void {
    this.store.upsertLocalChat({
      localKey: input.localKey,
      projectId: input.projectId,
      launchId: input.launchId,
      harness: input.harness,
      chatId: input.chatId,
      pending: input.pending,
      status: "working",
      title: input.title,
      cwd: input.cwd,
      host: this.host,
      environment: "cmux",
      linkedType: null,
      linkedPath: null,
      resumeKind: "open-chat-command",
      resumePayload: input.resumePayload,
      firstObservedAt: input.now,
      lastEventAt: input.now,
      lastStatusAt: input.now,
      endedAt: null,
      dirty: true,
      updatedAt: input.now,
    });
  }

  private async postChat(input: {
    projectId: string | null;
    harness: ServerHarness;
    title: string;
    cmuxRef: JsonObject;
    now: number;
  }): Promise<string> {
    const res = await this.client.daemon.chats.$post({
      json: {
        machineId: this.machineId,
        projectId: input.projectId,
        harness: input.harness,
        title: input.title,
        cmuxRef: input.cmuxRef,
        status: "busy",
        lastActivityAt: new Date(input.now).toISOString(),
      },
    });
    if (!res.ok) {
      throw new Error(`chat POST failed (${res.status}: ${await res.text().catch(() => "")})`);
    }
    const row = (await res.json()) as { id: string };
    return row.id;
  }

  private async getTask(id: string): Promise<WireTask> {
    const res = await this.client.tasks[":id"].$get({ param: { id } });
    if (!res.ok) throw new Error(`GET /tasks/${id} failed (${res.status})`);
    return (await res.json()) as WireTask;
  }

  private async getProject(id: string): Promise<WireProject | null> {
    const res = await this.client.projects[":id"].$get({ param: { id } });
    if (!res.ok) return null;
    return (await res.json()) as WireProject;
  }

  private async patchAssignment(
    id: string,
    json: { observedState?: ObservedState; chatId?: string | null },
  ): Promise<void> {
    const res = await this.client.daemon.assignments[":id"].$patch({ param: { id }, json });
    if (!res.ok) {
      throw new Error(`PATCH /daemon/assignments/${id} failed (${res.status})`);
    }
  }

  private async patchObserved(id: string, observedState: ObservedState): Promise<void> {
    await this.patchAssignment(id, { observedState });
  }

  private async patchObservedIfChanged(a: WireAssignment, next: ObservedState): Promise<void> {
    if ((a.observedState as ObservedState) === next) return;
    await this.patchObserved(a.id, next);
  }
}
