import { zValidator } from "@hono/zod-validator";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  or,
  type SQL,
} from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import { deriveChatStatus, type ChatBlock } from "../chatStatus.js";
import type { AppEnv, Db } from "../context.js";
import {
  assignments,
  attachments,
  chatEvents,
  chats,
  harness as harnessEnum,
  machines,
  projects,
  tasks,
} from "../db/schema.js";
import {
  assignmentObservationUpdate,
  autoTitleComplete,
  autoTitleListQuery,
  chatListQuery,
  chatSnapshot,
  idParam,
  machineHeartbeat,
  machineRegister,
} from "../validation.js";
import {
  notFound,
  ownedAssignment,
  ownedChat,
  ownedMachine,
  ownedProject,
} from "./helpers.js";

type ChatRow = typeof chats.$inferSelect;
type SnapshotHarness = (typeof harnessEnum.enumValues)[number];

// The natural key, in the one form the whole handler agrees on: it is the
// unique index (machine_id, harness, session_id) minus the machine, which is
// already fixed by the route param. Nothing here may key on session id alone.
const chatKey = (harness: string, sessionId: string) => harness + " " + sessionId;

// A relayed hook event whose kind starts with "block." is the ONLY thing that
// writes chats.block. "block.clear" (and its synonyms) means "no longer
// blocked"; anything else under block.* names the reason.
function blockFromEventKind(kind: string): ChatBlock | null | undefined {
  if (!kind.startsWith("block.")) return undefined;
  const reason = kind.slice("block.".length);
  if (reason === "permission" || reason === "question") return reason;
  if (reason === "clear" || reason === "cleared" || reason === "none") return null;
  return undefined;
}

// §7 sends `source` next to `evidence`; both describe what produced the
// observation, so they land in one jsonb the Inspector can read straight off.
function mergeEvidence(source: string | null | undefined, evidence: unknown): unknown {
  if (evidence === undefined) return source != null ? { source } : undefined;
  const isPlainObject = typeof evidence === "object" && evidence !== null && !Array.isArray(evidence);
  if (source == null) return evidence;
  return isPlainObject ? { source, ...(evidence as object) } : { source, evidence };
}

// Placeholder title for a chat we've never seen before. §7's snapshot carries
// no title (observation is title-blind), but chats.title is NOT NULL and the
// product renders it. Never used to overwrite an existing title.
function placeholderTitle(cwd: string | null | undefined, sessionId: string): string {
  const leaf = cwd?.replace(/\/+$/, "").split("/").filter(Boolean).pop();
  return leaf ? `${leaf} (${sessionId.slice(0, 8)})` : sessionId.slice(0, 8);
}

// Resolve the `task` attachment (an assignment id) to the project its task
// belongs to, so a discovered chat lands in the right project. Ownership is
// re-checked here — the daemon is authenticated, not trusted.
async function projectIdForAssignment(db: Db, userId: string, assignmentId: string) {
  const [row] = await db
    .select({ projectId: tasks.projectId })
    .from(assignments)
    .innerJoin(tasks, eq(assignments.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(assignments.id, assignmentId), eq(projects.userId, userId)));
  return row?.projectId ?? null;
}

// Daemon-facing routes (mounted at /daemon). The daemon authenticates with an
// api key (x-api-key → requireAuth, see auth.ts), and the ownership rule is
// enforced here: chats are daemon-created (single-creator-per-table), and the
// assignment PATCH below is the exact mirror image of the client one
// (observations only, never intent).
export const daemonRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  // Register/upsert-by-name: the daemon calls this on startup; a machine name
  // is stable per host ("wills-mbp"), so re-registering updates in place.
  .post("/machines", zValidator("json", machineRegister), async (c) => {
    const body = c.req.valid("json");
    const db = c.var.db;
    const [existing] = await db
      .select()
      .from(machines)
      .where(and(eq(machines.userId, c.var.userId), eq(machines.name, body.name)));
    if (existing) {
      const [row] = await db
        .update(machines)
        .set({ daemonVersion: body.daemonVersion, lastSeenAt: new Date() })
        .where(eq(machines.id, existing.id))
        .returning();
      return c.json(row);
    }
    const [row] = await db
      .insert(machines)
      .values({ ...body, userId: c.var.userId })
      .returning();
    return c.json(row, 201);
  })
  .patch(
    "/machines/:id/heartbeat",
    zValidator("param", idParam),
    zValidator("json", machineHeartbeat),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const existing = await ownedMachine(c.var.db, c.var.userId, id);
      if (!existing) return c.json(notFound, 404);
      const [row] = await c.var.db
        .update(machines)
        .set({
          lastSeenAt: new Date(),
          ...(patch.daemonVersion !== undefined ? { daemonVersion: patch.daemonVersion } : {}),
        })
        .where(eq(machines.id, id))
        .returning();
      return c.json(row);
    },
  )
  // ─── Task auto-titles ------------------------------------------------------
  // A non-null seed equal to the current title is the complete durable intent.
  // Multiple daemons may generate concurrently; the atomic completion CAS
  // makes all but the first harmless no-ops.
  .get("/auto-titles", zValidator("query", autoTitleListQuery), async (c) => {
    const { requesting_machine_id: machineId, limit } = c.req.valid("query");
    const machine = await ownedMachine(c.var.db, c.var.userId, machineId);
    if (!machine) return c.json(notFound, 404);
    const db = c.var.db;
    const rows = await db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(
        and(
          eq(projects.userId, c.var.userId),
          isNotNull(tasks.autoTitleSeed),
          eq(tasks.title, tasks.autoTitleSeed),
        ),
      )
      .orderBy(asc(tasks.createdAt))
      .limit(limit);
    const taskIds = rows.map(({ task }) => task.id);
    const files =
      taskIds.length === 0
        ? []
        : await db
            .select()
            .from(attachments)
            .where(
              and(
                inArray(attachments.taskId, taskIds),
                eq(attachments.state, "finalized"),
              ),
            )
            .orderBy(attachments.createdAt);
    return c.json(
      rows.map(({ task }) => ({
        task,
        attachments: files.filter((file) => file.taskId === task.id),
      })),
    );
  })
  .post(
    "/auto-titles/:id/complete",
    zValidator("param", idParam),
    zValidator("json", autoTitleComplete),
    async (c) => {
      const { id } = c.req.valid("param");
      const { machineId, title } = c.req.valid("json");
      const db = c.var.db;
      const [row] = await db
        .update(tasks)
        .set({
          ...(title === null ? {} : { title }),
          autoTitleSeed: null,
        })
        .where(
          and(
            eq(tasks.id, id),
            isNotNull(tasks.autoTitleSeed),
            eq(tasks.title, tasks.autoTitleSeed),
            exists(
              db
                .select({ id: projects.id })
                .from(projects)
                .where(
                  and(
                    eq(projects.id, tasks.projectId),
                    eq(projects.userId, c.var.userId),
                  ),
                ),
            ),
            exists(
              db
                .select({ id: machines.id })
                .from(machines)
                .where(
                  and(
                    eq(machines.id, machineId),
                    eq(machines.userId, c.var.userId),
                  ),
                ),
            ),
          ),
        )
        .returning();
      if (!row) return c.json({ error: "auto-title no longer active" }, 409);
      return c.json({ task: row, applied: title !== null });
    },
  )
  // The daemon's read of its own chats: the reconciler resolves an assignment's
  // chat here, and focus reads its `handle`. READ-ONLY — the snapshot PUT below
  // is the only writer of a chat row anywhere (the legacy POST/PATCH
  // /daemon/chats pair, and the `cmuxRef` wire alias they carried, were deleted
  // with the daemon's local chat model).
  .get("/chats", zValidator("query", chatListQuery), async (c) => {
    const { machine_id: machineId } = c.req.valid("query");
    const machine = await ownedMachine(c.var.db, c.var.userId, machineId);
    if (!machine) return c.json(notFound, 404);
    const rows = await c.var.db
      .select()
      .from(chats)
      .where(eq(chats.machineId, machineId))
      .orderBy(chats.lastActivityAt);
    return c.json(rows);
  })
  // ─── V3 chat snapshot ──────────────────────────────────────────────────────
  // docs/chat-tracking-redesign.md §7. The daemon PUTs its WHOLE working set
  // every tick; the server upserts by the natural key (machine, harness,
  // session), derives status, and — this is the entire heal path — marks
  // anything it expected to see but didn't as dead. No session.ended
  // dependency, no wedged rows possible by construction.
  .put(
    "/machines/:id/chat-snapshot",
    zValidator("param", idParam),
    zValidator("json", chatSnapshot),
    async (c) => {
      const { id: machineId } = c.req.valid("param");
      const body = c.req.valid("json");
      const db = c.var.db;
      const machine = await ownedMachine(db, c.var.userId, machineId);
      if (!machine) return c.json(notFound, 404);

      const observedAt = body.observedAt;

      // Two chats claiming the same (harness, sessionId) in one payload would
      // fight over the same row — reject rather than let last-write-wins hide it.
      const keys = new Set<string>();
      for (const chat of body.chats) {
        const key = chatKey(chat.harness, chat.sessionId);
        if (keys.has(key)) {
          return c.json({ error: `duplicate chat in snapshot: ${chat.harness}/${chat.sessionId}` }, 400);
        }
        keys.add(key);
      }

      // Resolve project attachments once per distinct id, not once per chat.
      const projectIds = new Set(body.chats.map((ch) => ch.projectId).filter((p) => p != null));
      const assignmentIds = new Set(
        body.chats.filter((ch) => ch.projectId == null).map((ch) => ch.task).filter((t) => t != null),
      );
      const ownedProjectIds = new Set<string>();
      for (const projectId of projectIds) {
        if (await ownedProject(db, c.var.userId, projectId)) ownedProjectIds.add(projectId);
      }
      const projectByAssignment = new Map<string, string | null>();
      for (const assignmentId of assignmentIds) {
        projectByAssignment.set(
          assignmentId,
          await projectIdForAssignment(db, c.var.userId, assignmentId),
        );
      }

      // Everything we might touch: the rows named by the snapshot, plus every
      // row that still carries an existence on this machine (the sweep set).
      //
      // `dormant` belongs in that set even though absence never kills a dormant
      // chat. Existence is a claim about what the machine can SEE, and a row
      // that has aged out of the window is one the daemon has stopped looking
      // at — leaving `dormant` on it is a stored copy no ground truth still
      // backs, the exact drift this architecture exists to prevent. Loading
      // only running/pending made that unfixable downstream: the row was never
      // fetched, so the sweep could not have cleared it.
      const sessionIds = body.chats.map((ch) => ch.sessionId);
      const eventSessionIds = body.events.map((e) => e.sessionId);
      const wanted = [...new Set([...sessionIds, ...eventSessionIds])];
      const preConds: SQL[] = [isNotNull(chats.existence)];
      if (wanted.length > 0) preConds.push(inArray(chats.sessionId, wanted));
      const priorRows = await db
        .select()
        .from(chats)
        .where(and(eq(chats.machineId, machineId), or(...preConds)));
      const priorByKey = new Map(
        priorRows.map((r) => [chatKey(r.harness, r.sessionId ?? ""), r] as const),
      );

      // Which harnesses on this machine answer to a given session id — from the
      // snapshot and from what we already had. Normally exactly one; two only
      // if Claude and Codex ever mint the same id.
      const harnessesBySession = new Map<string, Set<string>>();
      const rememberHarness = (harness: string, sessionId: string | null) => {
        if (!sessionId) return;
        const seen = harnessesBySession.get(sessionId) ?? new Set<string>();
        seen.add(harness);
        harnessesBySession.set(sessionId, seen);
      };
      for (const chat of body.chats) rememberHarness(chat.harness, chat.sessionId);
      for (const row of priorRows) rememberHarness(row.harness, row.sessionId);

      // Resolve every relayed event to a chat key ONCE — the block pre-scan and
      // the chat_events insert must land an event on the same chat, and both
      // use the full natural key, never the session id alone.
      //
      // `harness` on an event is optional (an older daemon omits it). Without
      // it we resolve by session id, and if more than one harness claims that
      // id the event is DROPPED rather than attached to a guess.
      const resolveEventKey = (event: {
        harness?: SnapshotHarness;
        sessionId: string;
      }): string | null => {
        const candidates = harnessesBySession.get(event.sessionId);
        if (!candidates || candidates.size === 0) return null;
        if (event.harness !== undefined) {
          return candidates.has(event.harness) ? chatKey(event.harness, event.sessionId) : null;
        }
        if (candidates.size > 1) return null; // ambiguous — never guess
        const [only] = candidates;
        return chatKey(only, event.sessionId);
      };
      const resolvedEvents = body.events.map((event) => ({ event, key: resolveEventKey(event) }));

      // The LAST block.* event per chat (by its producer timestamp) is the block
      // we persist, so the whole tick is one write per chat instead of an upsert
      // followed by a patch.
      const blockByKey = new Map<string, { at: Date; block: ChatBlock | null }>();
      for (const { event, key } of resolvedEvents) {
        if (key === null) continue;
        const block = blockFromEventKind(event.kind);
        if (block === undefined) continue;
        const seen = blockByKey.get(key);
        if (!seen || event.at >= seen.at) blockByKey.set(key, { at: event.at, block });
      }

      const result = await db.transaction(async (tx) => {
        const upserted: ChatRow[] = [];

        for (const chat of body.chats) {
          const prior = priorByKey.get(chatKey(chat.harness, chat.sessionId));
          // Block precedence: relayed event > the daemon's reported belief >
          // whatever we already had. Events own this axis (§3).
          const relayed = blockByKey.get(chatKey(chat.harness, chat.sessionId));
          const block =
            relayed !== undefined
              ? relayed.block
              : chat.block !== undefined
                ? chat.block
                : (prior?.block ?? null);
          const status = deriveChatStatus({
            existence: chat.existence,
            activity: chat.activity,
            block,
          });
          const evidence = mergeEvidence(chat.source, chat.evidence);
          const projectId =
            chat.projectId != null
              ? ownedProjectIds.has(chat.projectId)
                ? chat.projectId
                : null
              : chat.task != null
                ? (projectByAssignment.get(chat.task) ?? null)
                : undefined;
          // Working (or spawning) means activity now; otherwise last_activity_at
          // is left where it was so "idle since" stays meaningful.
          const active =
            chat.existence === "pending" ||
            (chat.existence === "running" && (chat.activity === "working" || block !== null));

          // Observations the daemon DID report. Anything it omitted is left
          // alone on update (a title-less tick must not blank a real title, a
          // handle-less tick must not drop the handle) — which is why every
          // optional field is spread conditionally rather than set to
          // undefined. `pid`/`process_started_at` are the exception: they are
          // set to null explicitly, because "no process" is itself a fact.
          const observed = {
            pid: chat.process?.pid ?? null,
            processStartedAt: chat.process?.startedAt ?? null,
            existence: chat.existence,
            activity: chat.activity,
            block,
            lastObservedAt: observedAt,
            status,
            ...(projectId !== undefined ? { projectId } : {}),
            ...(chat.cwd != null ? { cwd: chat.cwd } : {}),
            ...(evidence !== undefined ? { evidence } : {}),
            ...(chat.handle !== undefined ? { handle: chat.handle } : {}),
            ...(chat.title !== undefined ? { title: chat.title } : {}),
            ...(active ? { lastActivityAt: observedAt } : {}),
          } satisfies Partial<typeof chats.$inferInsert>;

          const [row] = await tx
            .insert(chats)
            .values({
              machineId,
              harness: chat.harness,
              sessionId: chat.sessionId,
              title: chat.title ?? placeholderTitle(chat.cwd, chat.sessionId),
              lastActivityAt: observedAt,
              ...observed,
            })
            .onConflictDoUpdate({
              target: [chats.machineId, chats.harness, chats.sessionId],
              set: observed,
            })
            .returning();
          upserted.push(row);
        }

        // Relayed events land verbatim. Resolve by session id against the rows
        // we just wrote, then against what we already had; an event for a chat
        // we've never seen has no row to hang off and is dropped (counted).
        const chatIdByKey = new Map<string, string>();
        for (const row of [...priorRows, ...upserted]) {
          if (row.sessionId) chatIdByKey.set(chatKey(row.harness, row.sessionId), row.id);
        }
        const eventValues = [];
        let eventsDropped = 0;
        for (const { event, key } of resolvedEvents) {
          const chatId = key === null ? undefined : chatIdByKey.get(key);
          if (!chatId) {
            eventsDropped++;
            continue;
          }
          eventValues.push({
            chatId,
            kind: event.kind,
            at: event.at,
            payload: event.payload ?? null,
          });
        }
        if (eventValues.length > 0) await tx.insert(chatEvents).values(eventValues);

        // The absence sweep. SKIPPED ENTIRELY when the daemon flagged the
        // window truncated: coverage was incomplete, so absence proves nothing.
        // The daemon already debounces two misses, so the server acts on the
        // FIRST absence it sees (no second debounce).
        //
        // Absence has TWO meanings and they are not the same fact (§5.3):
        //
        //   running/pending vanished → it DIED. We were watching a live process
        //     and it stopped being there. Status becomes dead.
        //   dormant vanished → we STOPPED LOOKING. Its transcript aged past the
        //     24h window. We know nothing new about it, and it is very likely
        //     still resumable, so its status is left exactly as it was —
        //     "aging out is not deletion; the chat keeps living on the server
        //     with its final status."
        //
        // What both share: the machine is no longer asserting anything about
        // this row, so `existence` — the machine-owned axis — must be cleared
        // either way. Clearing it is what makes the row honest; only the status
        // verdict differs. `last_observed_at` is deliberately NOT restamped on
        // the aged-out path: it means "when the machine last actually reported
        // this", and preserving it is what lets the Inspector say "absent, last
        // seen 46m ago" instead of claiming a sighting that never happened.
        let dead = 0;
        let agedOut = 0;
        if (!body.window.truncated) {
          const survivors = new Set(upserted.map((r) => r.id));
          const doomed = priorRows.filter((r) => !survivors.has(r.id));
          const lethal = doomed.filter(
            (r) => r.existence === "running" || r.existence === "pending",
          );
          const stoppedLooking = doomed.filter((r) => r.existence === "dormant");

          if (lethal.length > 0) {
            const swept = await tx
              .update(chats)
              .set({
                status: "dead",
                existence: null,
                // A block never outlives the process that raised it.
                block: null,
                lastObservedAt: observedAt,
              })
              .where(
                and(
                  eq(chats.machineId, machineId),
                  inArray(
                    chats.id,
                    lethal.map((r) => r.id),
                  ),
                ),
              )
              .returning({ id: chats.id });
            dead = swept.length;
          }

          if (stoppedLooking.length > 0) {
            const cleared = await tx
              .update(chats)
              .set({ existence: null })
              .where(
                and(
                  eq(chats.machineId, machineId),
                  inArray(
                    chats.id,
                    stoppedLooking.map((r) => r.id),
                  ),
                ),
              )
              .returning({ id: chats.id });
            agedOut = cleared.length;
          }
        }

        // Snapshot COVERAGE, on the machine. Not a per-chat fact: how far back
        // the daemon looked, its cap, and whether it saw everything describe
        // the tick. Without it the Chat Inspector's health strip can only
        // guess whether the rows it renders are current or fiction.
        await tx
          .update(machines)
          .set({
            chatSnapshotAt: observedAt,
            chatWindowSince: body.window.since,
            chatWindowCap: body.window.cap,
            chatWindowTruncated: body.window.truncated,
          })
          .where(eq(machines.id, machineId));

        return { upserted, dead, agedOut, events: eventValues.length, eventsDropped };
      });

      return c.json({
        observedAt: observedAt.toISOString(),
        truncated: body.window.truncated,
        upserted: result.upserted.length,
        dead: result.dead,
        // Distinct from `dead` on purpose: one is a chat that died, the other
        // is a chat we stopped watching. Collapsing them in the response would
        // undo the distinction the sweep just made.
        agedOut: result.agedOut,
        events: result.events,
        eventsDropped: result.eventsDropped,
        chats: result.upserted,
      });
    },
  )
  // Observation PATCH — DAEMON-writable fields ONLY (observed_state, chat_id,
  // worktree). desired_state/reviewed_at stay client-only; strictObject in
  // the schema rejects them with a 400.
  .patch(
    "/assignments/:id",
    zValidator("param", idParam),
    zValidator("json", assignmentObservationUpdate),
    async (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const db = c.var.db;
      const existing = await ownedAssignment(db, c.var.userId, id);
      if (!existing) return c.json(notFound, 404);
      if (patch.chatId != null) {
        const chat = await ownedChat(db, c.var.userId, patch.chatId);
        if (!chat) return c.json(notFound, 404);
      }
      const updates: Partial<typeof assignments.$inferInsert> = {};
      if (patch.observedState !== undefined) updates.observedState = patch.observedState;
      if (patch.chatId !== undefined) updates.chatId = patch.chatId;
      if (patch.worktree !== undefined) updates.worktree = patch.worktree;
      if (Object.keys(updates).length === 0) return c.json(existing);
      const [row] = await db
        .update(assignments)
        .set(updates)
        .where(eq(assignments.id, id))
        .returning();
      return c.json(row);
    },
  );
