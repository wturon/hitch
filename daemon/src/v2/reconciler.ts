// V2 reconciler core.
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
// NO LOCAL CHAT MODEL (docs/chat-tracking-redesign.md §6, phase D). The
// reconciler used to create a chat row at spawn through POST /daemon/chats and
// keep a parallel `local_chats` row it read observations back out of. Both are
// gone. What replaced them:
//
//   - a chat is created by ONE writer, the snapshot PUT. At spawn the
//     reconciler registers the launch with the ATTACHMENT layer
//     (daemon/src/attachment/), which pre-registers claude's known session id
//     as `existence: "pending"` in the very next snapshot and links the
//     assignment to the row the server echoes back.
//   - `deriveObserved` reads the SERVER chat's status + existence — the two
//     things the snapshot already maintains — instead of a local row.
//   - close resolves its target through the chat's `handle`, the nullable
//     jsonb that replaced `cmux_ref`.
//
// V1 is imported, never edited: cmux.ts / launchers wrap the real spawn/close.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type { AttachmentLayer } from "../attachment/index.js";
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
  /** Client intent to adopt an existing chat; the daemon fulfills it into chatId. */
  requestedChatId: string | null;
  chatId: string | null;
}
interface WireChat {
  id: string;
  harness: ServerHarness;
  sessionId: string | null;
  status: ServerChatStatus;
  existence: ServerExistence | null;
  /** Attachment 2 — how to focus/close. Null for a chat we didn't launch. */
  handle: unknown;
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
export type ServerExistence = "running" | "dormant" | "pending";

export interface ReconcilerLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

// ─── Pure decision logic (unit-tested in v2-reconciler-smoke) ────────────────

// The action the reconciler takes for one assignment, given desired vs observed,
// whether a chat is linked, and whether a launch for it is still in flight.
// Pure — the diff table lives here, testable without a server or cmux.
export type ReconcileDecision =
  | "attach"
  | "spawn"
  | "close"
  | "mark-done"
  | "fail-launch"
  | "observe"
  | "noop";

export interface AssignmentSnapshot {
  desiredState: DesiredState;
  observedState: ObservedState;
  hasChat: boolean;
  /** The client asked this assignment to adopt an already-observed chat. */
  hasRequestedChat: boolean;
  /**
   * A launch record for this assignment exists and hasn't been linked yet.
   * Durable (the attachment layer keeps it on disk), which is what lets a
   * restart tell "spawn in flight" from "spawn that never bound" — the two
   * states the codex gap sits between.
   */
  launchPending: boolean;
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
  // Existing-chat handoff: never spawn a second agent. The daemon resolves the
  // requested server chat and writes the authoritative chat_id.
  if (!a.hasChat && a.hasRequestedChat) return "attach";
  // Not acted on yet and no chat → claim + spawn, UNLESS a launch is already in
  // flight (a restart mid-spawn must never double-spawn). A pending row that
  // somehow already carries a chat is observed, not re-spawned.
  if (a.observedState === "pending") {
    if (a.hasChat) return "observe";
    return a.launchPending ? "noop" : "spawn";
  }
  // Spawned but never linked to a chat. Codex lives here legitimately: its
  // thread doesn't exist until the first prompt, so there is nothing to link
  // yet. Once the launch record ages out, though, it never bound — say so
  // rather than sitting in `spawning` forever.
  if (a.observedState === "spawning" && !a.hasChat) {
    return a.launchPending ? "noop" : "fail-launch";
  }
  // spawning | running | waiting_input: keep deriving observations from the chat.
  return a.hasChat ? "observe" : "noop";
}

/**
 * Map the linked SERVER chat's current state to an observed_state, or null when
 * no transition should be forced.
 *
 * This is the phase-D replacement for reading a local `local_chats` row. The
 * inputs are the two columns the snapshot maintains — `status` (derived by the
 * server from the three axes) and `existence` (what the machine reports) — plus
 * the assignment's CURRENT observed state, which is what lets a few honest
 * distinctions be drawn without any local memory:
 *
 *   chat row gone            → dead   (nothing was ever bound)
 *   status dead / no existence → dead from spawning (it never got going),
 *                                else done (it ran and ended)
 *   existence pending        → null   (we launched it; it hasn't bound yet)
 *   existence dormant        → done for CLAUDE once we've seen it live; null
 *                              otherwise (codex dormancy is a heuristic — see
 *                              codexObserver.ts — and a false "ended" closes a
 *                              live tab)
 *   running + busy           → running
 *   running + waiting_input  → waiting_input   (blocked on a human)
 *   running + idle           → waiting_input   ("agent finished a pass"), but
 *                              never straight out of `spawning`: a harness
 *                              reads idle for a beat before its first prompt
 *                              lands, and that is not a finished turn.
 */
export function deriveObserved(
  chat: {
    status: ServerChatStatus;
    existence: ServerExistence | null;
    harness: ServerHarness;
  } | null,
  current: ObservedState,
): ObservedState | null {
  if (chat === null) return "dead";
  const neverGotGoing = current === "pending" || current === "spawning";

  if (chat.status === "dead" || chat.existence === null) {
    return neverGotGoing ? "dead" : "done";
  }

  switch (chat.existence) {
    case "pending":
      return null;
    case "dormant":
      if (chat.harness !== "claude") return null;
      return current === "running" || current === "waiting_input" ? "done" : null;
    case "running":
      if (chat.status === "busy") return "running";
      if (chat.status === "waiting_input") return "waiting_input";
      return neverGotGoing ? null : "waiting_input";
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

export function existingChatAttachmentPatch(
  assignmentHarness: ServerHarness,
  requested: Pick<WireChat, "id" | "harness" | "existence"> | null,
): { chatId: string; observedState: "running" } | null {
  if (
    !requested ||
    requested.harness !== assignmentHarness ||
    requested.existence === null
  ) {
    return null;
  }
  // The chat existed before the assignment. Enter the normal observation
  // lifecycle as already-running; the next tick can honestly derive idle,
  // blocked, dormant, or dead without the new-launch grace period.
  return { chatId: requested.id, observedState: "running" };
}

// ─── Reconciler ──────────────────────────────────────────────────────────────

export interface ReconcilerOptions {
  client: HitchClient;
  /** The attachment layer: launch records, pre-registration, assignment links. */
  attachments: AttachmentLayer;
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

// Map the server harness enum to the launcher harness vocabulary.
function launcherHarness(harness: ServerHarness): Harness {
  return harness === "codex" ? "codex" : "claude-code";
}

export class Reconciler {
  private readonly client: HitchClient;
  private readonly attachments: AttachmentLayer;
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
  // server (a restart re-diffs safely off the durable launch record).
  private readonly inFlight = new Set<string>();

  constructor(options: ReconcilerOptions) {
    this.client = options.client;
    this.attachments = options.attachments;
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
    // Abandoned launches: report them, then let the fail-launch decision below
    // settle whatever assignment they belonged to.
    for (const assignmentId of this.attachments.sweep()) {
      this.logger.info(`[hitch] launch for assignment ${assignmentId} expired without binding`);
    }
    if (assignments.length === 0) return;
    // A FAILED chat read is not an empty one: concluding `dead` from a network
    // error would kill every live assignment on this machine. Skip the pass.
    const chatsById = await this.fetchMachineChats();
    if (!chatsById) return;
    // The other half of the link path (the first is the snapshot PUT's echo):
    // resolve any assignment still waiting for its chat id.
    await this.attachments.resolveLinks([...chatsById.values()]);
    // Read the durable launch records ONCE for the whole pass.
    const pendingLaunches = this.attachments.pendingLaunches();

    for (const a of assignments) {
      if (this.stopped) return;
      const decision = decideAction({
        desiredState: a.desiredState as DesiredState,
        observedState: a.observedState as ObservedState,
        hasChat: a.chatId != null,
        hasRequestedChat: a.requestedChatId != null,
        launchPending: this.inFlight.has(a.id) || pendingLaunches.has(a.id),
      });
      switch (decision) {
        case "attach":
          await this.attachExisting(a, chatsById);
          break;
        case "spawn":
          this.claimAndSpawn(a);
          break;
        case "close":
          this.claimAndClose(a, chatsById);
          break;
        case "mark-done":
          this.attachments.forgetAssignment(a.id);
          await this.patchObservedIfChanged(a, "done");
          break;
        case "fail-launch":
          this.logger.info(
            `[hitch] assignment ${a.id} spawned but never bound to a chat — marking dead`,
          );
          this.attachments.forgetAssignment(a.id);
          await this.patchObservedIfChanged(a, "dead");
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

  /** Null means the read FAILED (≠ "no chats"), so the caller skips the pass. */
  private async fetchMachineChats(): Promise<Map<string, WireChat> | null> {
    try {
      const res = await this.client.daemon.chats.$get({
        query: { machine_id: this.machineId },
      });
      if (!res.ok) {
        this.logger.error?.(`[hitch] GET /daemon/chats failed (${res.status})`);
        return null;
      }
      const byId = new Map<string, WireChat>();
      for (const chat of (await res.json()) as WireChat[]) byId.set(chat.id, chat);
      return byId;
    } catch (error) {
      this.logger.error?.(`[hitch] GET /daemon/chats error: ${String(error)}`);
      return null;
    }
  }

  // ─── Spawn ─────────────────────────────────────────────────────────────────

  private async attachExisting(
    a: WireAssignment,
    chatsById: Map<string, WireChat>,
  ): Promise<void> {
    const requested = a.requestedChatId
      ? (chatsById.get(a.requestedChatId) ?? null)
      : null;
    const patch = existingChatAttachmentPatch(a.harness, requested);
    if (!patch) {
      this.logger.info(
        `[hitch] requested chat for assignment ${a.id} is no longer live — marking dead`,
      );
      await this.patchObservedIfChanged(a, "dead");
      return;
    }
    await this.patchAssignment(a.id, patch);
    this.logger.info(
      `[hitch] attached existing ${a.harness} chat ${patch.chatId} ` +
        `to assignment ${a.id}`,
    );
  }

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
        this.attachments.forgetAssignment(a.id);
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
    // assignments.prompt VERBATIM — the daemon never composes a prompt. The
    // server resolves the template when the assignment is created (see
    // server/src/prompt.ts), so this column is the exact text the user approved
    // in the delegate bar.
    //
    // Null means the row predates server-side resolution, or a NEW daemon is
    // talking to an OLD server (the daemon ships inside the desktop app and
    // updates on its own schedule — deploy the server first). Fail the launch
    // rather than spawn an agent with an empty prompt: a visible dead
    // assignment beats a confused agent sitting in a tab, and re-inventing a
    // preamble here is exactly the duplication this change removed.
    // BLANK counts, not just null: the server never stores an empty prompt (it
    // falls back to the default template), so an empty one here means the same
    // broken-row condition and would spawn an agent with no instructions.
    if (a.prompt == null || a.prompt.trim() === "") {
      throw new Error(
        `assignment ${a.id} has no prompt — the server did not resolve one ` +
          `(is it running a build older than the daemon?)`,
      );
    }
    const prompt = a.prompt;
    const serverHarness = (a.harness as ServerHarness) ?? "claude";
    const harness = launcherHarness(serverHarness);
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

    // 1. Record the launch BEFORE anything observable happens. Durable, so a
    //    crash between here and the spawn re-diffs to "already in flight"
    //    instead of spawning a second agent.
    this.attachments.registerLaunch({
      launchId,
      assignmentId: a.id,
      harness: serverHarness,
      cwd,
      projectId: task.projectId,
      title,
    });

    try {
      // 2. Write the observable state next, still before the harness runs.
      await this.patchAssignment(a.id, { observedState: "spawning" });
      this.logger.info(
        `[hitch] reconciler spawning ${serverHarness} for assignment ${a.id} ` +
          `(launch ${launchId.slice(0, 8)})`,
      );

      // 3. Spawn. `onLinked` fires only for launchers that pin a session id up
      //    front — claude (`--session-id`) and the fake launcher. Codex has no
      //    id to pin: its thread is bound later, off the hook event that
      //    carries the cmux surface (see daemon/src/attachment/).
      await launcher.startNew({
        launchId,
        taskKey: `assignment:${a.id}`,
        prompt,
        cwd,
        title,
        model,
        effort,
        project: projectRef,
        logger: this.logger,
        onLinked: async (sessionId) => {
          this.attachments.bindSession(launchId, sessionId);
          this.logger.info(
            `[hitch] reconciler pre-registered ${serverHarness} session ` +
              `${sessionId.slice(0, 8)} for assignment ${a.id}`,
          );
        },
      });
    } catch (error) {
      this.attachments.dropLaunch(launchId);
      throw error;
    }
  }

  // ─── Close (Decision 3: execute desired=stopped) ──────────────────────────

  private claimAndClose(a: WireAssignment, chatsById: Map<string, WireChat>): void {
    if (this.inFlight.has(a.id)) return;
    this.inFlight.add(a.id);
    void this.close(a, chatsById)
      .catch((error) => {
        this.logger.error?.(
          `[hitch] reconciler close failed for assignment ${a.id}: ${String(error)}`,
        );
      })
      .finally(() => this.inFlight.delete(a.id));
  }

  private async close(a: WireAssignment, chatsById: Map<string, WireChat>): Promise<void> {
    const chat = a.chatId ? (chatsById.get(a.chatId) ?? null) : null;
    // Attachment 2 (§4): the handle says how to get back to a chat. A chat with
    // no handle is a complete, correct chat — it just isn't ours to close.
    const sessionId = closeTarget(chat);
    const harness = launcherHarness((a.harness as ServerHarness) ?? "claude");
    const launcher = this.resolveLauncher(harness, "cmux");
    if (sessionId && launcher?.close) {
      await launcher.close({
        sessionId,
        project: { projectId: a.chatId ?? this.machineId, projectName: "" },
      });
      this.logger.info(`[hitch] reconciler closed chat for assignment ${a.id}`);
    } else {
      // Nothing bound to close (a codex launch that never reported a thread, a
      // chat we only ever observed) — the goal state already holds; settle.
      this.logger.info(`[hitch] reconciler: no live chat to close for assignment ${a.id}`);
    }
    this.attachments.forgetAssignment(a.id);
    await this.patchObserved(a.id, "done");
  }

  // ─── Observe (transition-only PATCHes) ────────────────────────────────────

  private async observe(a: WireAssignment, chatsById: Map<string, WireChat>): Promise<void> {
    const chat = a.chatId ? (chatsById.get(a.chatId) ?? null) : null;
    const derived = deriveObserved(
      chat && {
        status: chat.status,
        existence: chat.existence ?? null,
        harness: (chat.harness ?? a.harness ?? "claude") as ServerHarness,
      },
      a.observedState as ObservedState,
    );
    const next = observationTransition(a.observedState as ObservedState, derived);
    if (!next) return;
    if (next === "done" || next === "dead") this.attachments.forgetAssignment(a.id);
    await this.patchObserved(a.id, next);
  }

  // ─── Server helpers ────────────────────────────────────────────────────────

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

/**
 * The session id to close, read off the chat's `handle`. Exported for the
 * smoke: the rule is that a chat we did not launch has no handle and is
 * therefore not ours to close (§4's accepted asymmetry — we see everything, we
 * can return you to what we launched).
 */
export function closeTarget(
  chat: { sessionId?: string | null; handle?: unknown } | null,
): string | null {
  if (!chat) return null;
  const handle = chat.handle;
  if (typeof handle !== "object" || handle === null || Array.isArray(handle)) return null;
  const fromHandle = (handle as Record<string, unknown>).sessionId;
  if (typeof fromHandle === "string" && fromHandle.trim()) return fromHandle;
  // A handle with no session id still says "we launched this"; fall back to the
  // chat's own session id, which is the same value by construction.
  return typeof chat.sessionId === "string" && chat.sessionId.trim() ? chat.sessionId : null;
}
