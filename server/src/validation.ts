import { z } from "zod";

import {
  assignmentDesiredState,
  assignmentObservedState,
  authorKind,
  chatActivity,
  chatBlock,
  chatExistence,
  chatStatus,
  harness,
  taskStatus,
} from "./db/schema.js";

// All enum schemas are derived from the Drizzle pgEnums — never retyped.
export const taskStatusSchema = z.enum(taskStatus.enumValues);
export const authorKindSchema = z.enum(authorKind.enumValues);
export const harnessSchema = z.enum(harness.enumValues);
export const desiredStateSchema = z.enum(assignmentDesiredState.enumValues);
export const observedStateSchema = z.enum(assignmentObservedState.enumValues);
export const chatStatusSchema = z.enum(chatStatus.enumValues);
export const chatExistenceSchema = z.enum(chatExistence.enumValues);
export const chatActivitySchema = z.enum(chatActivity.enumValues);
export const chatBlockSchema = z.enum(chatBlock.enumValues);

// Timestamps cross the wire as ISO-8601 strings and land as Dates.
const isoDate = () => z.iso.datetime({ offset: true }).transform((s) => new Date(s));

// Bodies are strictObject on purpose: unknown keys are a 400, which is what
// enforces the ownership split on assignments (client can never smuggle
// observed_state; daemon can never smuggle desired_state).

export const idParam = z.object({ id: z.uuid() });
export const taskTagParams = z.object({ id: z.uuid(), tagId: z.uuid() });

// --- projects ---------------------------------------------------------------

export const projectCreate = z.strictObject({
  name: z.string().min(1),
  repoPath: z.string().nullable().optional(),
  sortOrder: z.string().min(1),
});

export const projectUpdate = z.strictObject({
  name: z.string().min(1).optional(),
  repoPath: z.string().nullable().optional(),
  sortOrder: z.string().min(1).optional(),
});

// --- sections ---------------------------------------------------------------

export const sectionListQuery = z.object({ project_id: z.uuid().optional() });

export const sectionCreate = z.strictObject({
  projectId: z.uuid(),
  name: z.string().min(1),
  sortOrder: z.string().min(1),
});

export const sectionUpdate = z.strictObject({
  name: z.string().min(1).optional(),
  sortOrder: z.string().min(1).optional(),
});

// --- tasks ------------------------------------------------------------------

export const taskListQuery = z.object({
  project_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  status: taskStatusSchema.optional(),
  tag_id: z.uuid().optional(),
});

// projectId is required at the API layer even though the column is nullable:
// tasks have no user_id column, so a project-less task has no ownership path
// and could never be scoped. Revisit if an inbox concept lands (needs
// tasks.user_id).
export const taskCreate = z.strictObject({
  projectId: z.uuid(),
  sectionId: z.uuid().nullable().optional(),
  // VERBATIM passthrough — capture text is sacred, never trim/transform.
  title: z.string().min(1),
  body: z.string().default(""),
  sortOrder: z.string().min(1),
});

export const taskUpdate = z.strictObject({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: taskStatusSchema.optional(),
  projectId: z.uuid().optional(),
  sectionId: z.uuid().nullable().optional(),
  sortOrder: z.string().min(1).optional(),
});

// --- tags -------------------------------------------------------------------

export const tagCreate = z.strictObject({
  name: z.string().min(1),
  color: z.string().min(1),
});

export const tagUpdate = z.strictObject({
  name: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
});

// --- comments ---------------------------------------------------------------

export const commentListQuery = z.object({ task_id: z.uuid() });

export const commentCreate = z.strictObject({
  taskId: z.uuid(),
  authorKind: authorKindSchema,
  assignmentId: z.uuid().optional(),
  body: z.string(),
});

export const commentUpdate = z.strictObject({ body: z.string() });

// --- attachments -------------------------------------------------------------

// Exactly one of task_id/comment_id, mirroring the create rule below.
export const attachmentListQuery = z
  .object({
    task_id: z.uuid().optional(),
    comment_id: z.uuid().optional(),
  })
  .refine((q) => (q.task_id === undefined) !== (q.comment_id === undefined), {
    message: "exactly one of task_id/comment_id is required",
  });

// Mirrors the DB CHECK (attachments_exactly_one_parent): exactly one of
// taskId/commentId. size/sha256 are the CLIENT'S declaration — the real size
// is verified against S3 at finalize-time.
export const attachmentCreate = z
  .strictObject({
    taskId: z.uuid().optional(),
    commentId: z.uuid().optional(),
    filename: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .refine((b) => (b.taskId === undefined) !== (b.commentId === undefined), {
    message: "exactly one of taskId/commentId is required",
  });

// --- assignments (client-facing) --------------------------------------------

export const assignmentListQuery = z.object({
  task_id: z.uuid().optional(),
  attention: z.enum(["true", "false"]).optional(),
});

export const assignmentCreate = z.strictObject({
  taskId: z.uuid(),
  machineId: z.uuid(),
  harness: harnessSchema,
  // A TEMPLATE, not the final prompt: the server substitutes $TASK_TITLE /
  // $TASK_BODY / $TASK_ID and stores the result in assignments.prompt. Omitting
  // it uses DEFAULT_PROMPT_TEMPLATE. The old `prompt` field is gone on purpose
  // — strictObject rejects it, so a client that still sends a pre-composed
  // prompt fails loudly instead of silently bypassing resolution.
  promptTemplate: z.string().optional(),
  // Kickoff-only launch params (mirror the nullable schema columns). Optional
  // AND nullable: omitting them, or passing null, means "harness default" — the
  // daemon falls back to the launcher's argv defaults (today's behavior).
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  desiredState: desiredStateSchema.default("running"),
});

// CLIENT-writable fields ONLY (single-creator-per-table rule): observed_state,
// chat_id and worktree are daemon-only and rejected here by strictObject.
export const assignmentClientUpdate = z.strictObject({
  desiredState: desiredStateSchema.optional(),
  reviewedAt: isoDate().nullable().optional(),
});

// --- daemon-facing ----------------------------------------------------------

export const machineRegister = z.strictObject({
  name: z.string().min(1),
  daemonVersion: z.string().min(1),
});

export const machineHeartbeat = z.strictObject({
  daemonVersion: z.string().min(1).optional(),
});

export const chatListQuery = z.object({ machine_id: z.uuid() });

// --- chat snapshot (V3) ------------------------------------------------------
// docs/chat-tracking-redesign.md §7. The whole working set every tick, each
// chat carrying its own existence. Not strictObject: the daemon and server ship
// separately, and a newer daemon adding a field must not 400 an older server.

const chatSnapshotWindow = z.object({
  since: isoDate(),
  cap: z.number().int().nonnegative(),
  // Coverage was incomplete — the server must NOT conclude anything from
  // absence on this tick. Defaults false so an omitted flag means "complete",
  // which matches §7's example payload.
  truncated: z.boolean().default(false),
});

const chatSnapshotProcess = z.object({
  pid: z.number().int(),
  // Kernel start-time. Free-form epoch units (the daemon owns the clock); it is
  // only ever compared against itself, so the server just stores it.
  startedAt: z.number().int().nullable().optional(),
});

const chatSnapshotChat = z.object({
  harness: harnessSchema,
  sessionId: z.string().min(1),
  cwd: z.string().nullable().optional(),
  process: chatSnapshotProcess.nullable().optional(),
  existence: chatExistenceSchema,
  activity: chatActivitySchema,
  // The daemon's current belief about the block, if it kept one across ticks.
  // Relayed events below still win — they are applied after the upsert.
  block: chatBlockSchema.nullable().optional(),
  // §7 sends `source` alongside `evidence`; it is folded into the evidence
  // jsonb so the Inspector has one place to read.
  source: z.string().nullable().optional(),
  evidence: z.json().optional(),
  // Attachment 1 — the assignment this chat serves. Null for found chats.
  task: z.uuid().nullable().optional(),
  // Direct project attachment; wins over `task` when both are present.
  projectId: z.uuid().nullable().optional(),
  // Attachment 2 — focus/close handle. Always nullable.
  handle: z.json().optional(),
  // Not in §7: chats.title is NOT NULL, so a first sighting needs something.
  // Omit it and the server derives a placeholder from cwd/sessionId; it is
  // never overwritten with a placeholder once a real title exists.
  title: z.string().min(1).optional(),
});

const chatSnapshotEvent = z.object({
  sessionId: z.string().min(1),
  // OPTIONAL, not required: §7's event object carries only a session id, and an
  // older daemon must keep working. Supplied, it completes the natural key —
  // without it the server resolves by session id alone and DROPS the event if
  // more than one harness on this machine claims that id (never guesses).
  harness: harnessSchema.optional(),
  kind: z.string().min(1),
  at: isoDate(),
  payload: z.json().optional(),
});

export const chatSnapshot = z.object({
  observedAt: isoDate(),
  window: chatSnapshotWindow,
  chats: z.array(chatSnapshotChat),
  events: z.array(chatSnapshotEvent).default([]),
});

// --- chats (client-facing) ---------------------------------------------------

export const chatClientListQuery = z.object({
  machine_id: z.uuid().optional(),
  // "true" → hide chats the machine has stopped seeing (status = dead).
  live: z.enum(["true", "false"]).optional(),
});

// The Inspector's per-chat event tail. Bounded by default AND by ceiling: this
// is an inbox landing zone, not a ledger, and nothing wants all of it.
export const chatEventListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// DAEMON-writable fields ONLY — the mirror image of assignmentClientUpdate.
export const assignmentObservationUpdate = z.strictObject({
  observedState: observedStateSchema.optional(),
  chatId: z.uuid().nullable().optional(),
  worktree: z.string().nullable().optional(),
});
