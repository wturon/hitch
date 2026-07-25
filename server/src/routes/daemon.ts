import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { requireAuth } from "../auth.js";
import { deriveChatStatus, type ChatBlock } from "../chatStatus.js";
import type { AppEnv, Db } from "../context.js";
import {
  assignments,
  chatEvents,
  chats,
  harness as harnessEnum,
  machines,
  projects,
  tasks,
} from "../db/schema.js";
import {
  assignmentObservationUpdate,
  chatCreate,
  chatListQuery,
  chatSnapshot,
  chatUpdate,
  idParam,
  machineHeartbeat,
  machineRegister,
} from "../validation.js";
import { notFound, ownedAssignment, ownedChat, ownedMachine, ownedProject } from "./helpers.js";

type ChatRow = typeof chats.$inferSelect;
type SnapshotHarness = (typeof harnessEnum.enumValues)[number];

// The natural key, in the one form the whole handler agrees on: it is the
// unique index (machine_id, harness, session_id) minus the machine, which is
// already fixed by the route param. Nothing here may key on session id alone.
const chatKey = (harness: string, sessionId: string) => harness + " " + sessionId;

// BACK-COMPAT. `chats.cmux_ref` became the nullable `chats.handle`, but the
// shipped daemon reads `cmuxRef` off every chat it gets back from these
// endpoints (daemon/src/v2/reconciler.ts, focus.ts). The legacy routes keep
// echoing it until that daemon is retired; the snapshot route below does not.
const withCmuxRef = <T extends { handle: unknown }>(row: T) => ({ ...row, cmuxRef: row.handle });

// TRANSITIONAL (delete with the legacy routes). The shipping daemon creates
// chats through POST /daemon/chats while ALSO PUTting snapshots. The legacy
// route has no session_id field of its own — but the ref it sends carries one,
// and the snapshot upserts on (machine_id, harness, session_id). Left alone the
// two writers make TWO rows for one chat. So the legacy routes lift the session
// id out of the ref, which lands both writers on the same row via the unique
// index. Nothing else about the legacy contract changes.
function sessionIdFromRef(ref: unknown): string | null {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  const value = (ref as Record<string, unknown>).sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

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
  .get("/chats", zValidator("query", chatListQuery), async (c) => {
    const { machine_id: machineId } = c.req.valid("query");
    const machine = await ownedMachine(c.var.db, c.var.userId, machineId);
    if (!machine) return c.json(notFound, 404);
    const rows = await c.var.db
      .select()
      .from(chats)
      .where(eq(chats.machineId, machineId))
      .orderBy(chats.lastActivityAt);
    return c.json(rows.map(withCmuxRef));
  })
  .post("/chats", zValidator("json", chatCreate), async (c) => {
    const { cmuxRef, ...rest } = c.req.valid("json");
    const db = c.var.db;
    const machine = await ownedMachine(db, c.var.userId, rest.machineId);
    if (!machine) return c.json(notFound, 404);
    if (rest.projectId != null) {
      const project = await ownedProject(db, c.var.userId, rest.projectId);
      if (!project) return c.json(notFound, 404);
    }
    const sessionId = sessionIdFromRef(cmuxRef);
    // With a session id this is an UPSERT on the natural key, not an insert: a
    // snapshot may already have created the row for this exact chat, and a
    // second POST for the same session (a re-spawn) must update rather than
    // violate the unique index. Without one it stays a plain insert — legacy
    // rows have a NULL session_id, which postgres treats as distinct.
    const [row] = sessionId
      ? await db
          .insert(chats)
          .values({ ...rest, sessionId, handle: cmuxRef })
          .onConflictDoUpdate({
            target: [chats.machineId, chats.harness, chats.sessionId],
            set: {
              ...(rest.projectId !== undefined ? { projectId: rest.projectId } : {}),
              title: rest.title,
              status: rest.status,
              handle: cmuxRef,
              ...(rest.lastActivityAt !== undefined
                ? { lastActivityAt: rest.lastActivityAt }
                : {}),
            },
          })
          .returning()
      : await db
          .insert(chats)
          .values({ ...rest, handle: cmuxRef })
          .returning();
    return c.json(withCmuxRef(row), 201);
  })
  .patch("/chats/:id", zValidator("param", idParam), zValidator("json", chatUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const { cmuxRef, ...patch } = c.req.valid("json");
    const db = c.var.db;
    const existing = await ownedChat(db, c.var.userId, id);
    if (!existing) return c.json(notFound, 404);
    if (patch.machineId !== undefined) {
      const machine = await ownedMachine(db, c.var.userId, patch.machineId);
      if (!machine) return c.json(notFound, 404);
    }
    if (patch.projectId != null) {
      const project = await ownedProject(db, c.var.userId, patch.projectId);
      if (!project) return c.json(notFound, 404);
    }
    const updates: Partial<typeof chats.$inferInsert> = {
      ...patch,
      ...(cmuxRef !== undefined ? { handle: cmuxRef } : {}),
    };
    // Same transitional convergence as POST above. A codex chat learns its
    // thread id only mid-launch and PATCHes it in, so this is where that row
    // acquires its session id. Guarded: if ANOTHER row already owns
    // (machine, harness, session) we leave session_id alone rather than
    // violating the unique index — worse (two rows) beats a 500.
    const patchedSessionId = cmuxRef !== undefined ? sessionIdFromRef(cmuxRef) : null;
    if (patchedSessionId && patchedSessionId !== existing.sessionId) {
      const machineId = patch.machineId ?? existing.machineId;
      const harness = patch.harness ?? existing.harness;
      const [clash] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(
          and(
            eq(chats.machineId, machineId),
            eq(chats.harness, harness),
            eq(chats.sessionId, patchedSessionId),
          ),
        );
      if (!clash || clash.id === id) updates.sessionId = patchedSessionId;
    }
    if (Object.keys(updates).length === 0) return c.json(withCmuxRef(existing));
    const [row] = await db.update(chats).set(updates).where(eq(chats.id, id)).returning();
    return c.json(withCmuxRef(row));
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
      // row we currently believe is alive on this machine (the sweep set).
      const sessionIds = body.chats.map((ch) => ch.sessionId);
      const eventSessionIds = body.events.map((e) => e.sessionId);
      const wanted = [...new Set([...sessionIds, ...eventSessionIds])];
      const preConds: SQL[] = [inArray(chats.existence, ["running", "pending"])];
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

        // The death sweep — absence means dead. SKIPPED ENTIRELY when the
        // daemon flagged the window truncated: coverage was incomplete, so
        // absence proves nothing. The daemon already debounces two misses, so
        // the server acts on the FIRST absence it sees (no second debounce).
        let dead = 0;
        if (!body.window.truncated) {
          const survivors = new Set(upserted.map((r) => r.id));
          const doomed = priorRows.filter((r) => !survivors.has(r.id));
          if (doomed.length > 0) {
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
                    doomed.map((r) => r.id),
                  ),
                  inArray(chats.existence, ["running", "pending"]),
                ),
              )
              .returning({ id: chats.id });
            dead = swept.length;
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

        return { upserted, dead, events: eventValues.length, eventsDropped };
      });

      return c.json({
        observedAt: observedAt.toISOString(),
        truncated: body.window.truncated,
        upserted: result.upserted.length,
        dead: result.dead,
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
