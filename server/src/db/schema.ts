import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

// Schema v1 (CLOSED) — see docs/v2-prd.md "Schema v1". Conventions:
// - uuidv7 PKs, app-generated via $defaultFn (postgres:16 has no native uuidv7)
// - sort_order = fractional-index strings (Figma-style)
// - created_at/updated_at timestamptz; updated_at maintained by trigger (migration 0001)
// - NOTIFY trigger on every table (migration 0001)

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const taskStatus = pgEnum("task_status", ["open", "done"]);
export const authorKind = pgEnum("author_kind", ["user", "agent"]);
export const attachmentState = pgEnum("attachment_state", ["pending", "finalized"]);
export const harness = pgEnum("harness", ["claude", "codex"]);
export const assignmentDesiredState = pgEnum("assignment_desired_state", ["running", "stopped"]);
export const assignmentObservedState = pgEnum("assignment_observed_state", [
  "pending",
  "spawning",
  "running",
  "waiting_input",
  "done",
  "dead",
]);
export const chatStatus = pgEnum("chat_status", ["busy", "waiting_input", "idle", "dead"]);

// ---------------------------------------------------------------------------
// Intent tables (written by client/CLI)
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: id(),
    // Step 4 (better-auth) adds the FK to the auth-owned user table.
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // ⚠ machine-specific on a shared table — fine at 1 machine; becomes a
    // project_paths(project_id, machine_id, path) join if a 2nd machine appears.
    repoPath: text("repo_path"),
    sortOrder: text("sort_order").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_user_id_idx").on(t.userId)],
);

export const sections = pgTable(
  "sections",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: text("sort_order").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sections_project_id_idx").on(t.projectId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    // Deleting a project deletes its tasks (Todoist semantics); deleting a
    // section drops its tasks back to the project root, never mass-deletes.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id").references(() => sections.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    // Markdown, stored VERBATIM — capture text is sacred, never transform.
    body: text("body").notNull(),
    status: taskStatus("status").notNull().default("open"),
    sortOrder: text("sort_order").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_project_id_idx").on(t.projectId),
    index("tasks_section_id_idx").on(t.sectionId),
    index("tasks_status_idx").on(t.status),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: id(),
    // Step 4 (better-auth) adds the FK to the auth-owned user table.
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // Named tint, e.g. "olive" — client owns the palette.
    color: text("color").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tags_user_id_name_unique").on(t.userId, t.name)],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.tagId] }),
    index("task_tags_tag_id_idx").on(t.tagId),
  ],
);

// ---------------------------------------------------------------------------
// Execution tables
// ---------------------------------------------------------------------------

export const machines = pgTable("machines", {
  id: id(),
  // Step 4 (better-auth) adds the FK to the auth-owned user table.
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  daemonVersion: text("daemon_version").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Daemon-created; can exist task-free for ad-hoc chats. ALL columns daemon-written.
export const chats = pgTable(
  "chats",
  {
    id: id(),
    // NO ACTION on purpose: machines with history shouldn't be silently deletable.
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    harness: harness("harness").notNull(),
    title: text("title").notNull(),
    cmuxRef: jsonb("cmux_ref").notNull(),
    status: chatStatus("status").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("chats_machine_id_idx").on(t.machineId),
    index("chats_project_id_idx").on(t.projectId),
  ],
);

// One handoff of a task to an agent on a machine. Append-only; created by
// client/CLI (intent) — observed_state and chat_id/worktree are DAEMON-ONLY.
export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // NO ACTION on purpose: machines with history shouldn't be silently deletable.
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    harness: harness("harness").notNull(),
    prompt: text("prompt"),
    desiredState: assignmentDesiredState("desired_state").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    observedState: assignmentObservedState("observed_state").notNull().default("pending"),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    worktree: text("worktree"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("assignments_task_id_idx").on(t.taskId),
    index("assignments_machine_id_idx").on(t.machineId),
    index("assignments_chat_id_idx").on(t.chatId),
    index("assignments_observed_state_idx").on(t.observedState),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorKind: authorKind("author_kind").notNull(),
    assignmentId: uuid("assignment_id").references(() => assignments.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("comments_task_id_idx").on(t.taskId),
    index("comments_assignment_id_idx").on(t.assignmentId),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    // Cascade deletes may orphan S3 objects — accepted for v1.
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    // S3 object key — never a URL.
    key: text("key").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    state: attachmentState("state").notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("attachments_task_id_idx").on(t.taskId),
    index("attachments_comment_id_idx").on(t.commentId),
    check(
      "attachments_exactly_one_parent",
      sql`(${t.taskId} IS NULL) <> (${t.commentId} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Row types ($inferSelect) — re-exported through @hitch/server for shared/.
// ---------------------------------------------------------------------------

export type Project = typeof projects.$inferSelect;
export type Section = typeof sections.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type TaskTag = typeof taskTags.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
