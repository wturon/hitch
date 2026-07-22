import { z } from "zod";

import {
  assignmentDesiredState,
  assignmentObservedState,
  authorKind,
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
  prompt: z.string().optional(),
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

export const chatCreate = z.strictObject({
  machineId: z.uuid(),
  projectId: z.uuid().nullable().optional(),
  harness: harnessSchema,
  title: z.string(),
  cmuxRef: z.json(),
  status: chatStatusSchema,
  lastActivityAt: isoDate().optional(),
});

export const chatUpdate = z.strictObject({
  machineId: z.uuid().optional(),
  projectId: z.uuid().nullable().optional(),
  harness: harnessSchema.optional(),
  title: z.string().optional(),
  cmuxRef: z.json().optional(),
  status: chatStatusSchema.optional(),
  lastActivityAt: isoDate().optional(),
});

// DAEMON-writable fields ONLY — the mirror image of assignmentClientUpdate.
export const assignmentObservationUpdate = z.strictObject({
  observedState: observedStateSchema.optional(),
  chatId: z.uuid().nullable().optional(),
  worktree: z.string().nullable().optional(),
});
