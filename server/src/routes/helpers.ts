import { and, eq } from "drizzle-orm";

import type { Db } from "../context.js";
import {
  assignments,
  attachments,
  chats,
  comments,
  machines,
  projects,
  sections,
  tags,
  tasks,
} from "../db/schema.js";

// Ownership lookups. Every helper returns the row when it exists AND belongs
// to `userId`, and undefined otherwise — callers turn undefined into a 404,
// so "not found" and "not yours" are indistinguishable on purpose.
// Tables without a user_id column scope through their parent chain
// (task → project → user, chat → machine → user, ...).

export const notFound = { error: "not found" } as const;

export async function ownedProject(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)));
  return row;
}

export async function ownedSection(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ section: sections })
    .from(sections)
    .innerJoin(projects, eq(sections.projectId, projects.id))
    .where(and(eq(sections.id, id), eq(projects.userId, userId)));
  return row?.section;
}

export async function ownedTask(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.id, id), eq(projects.userId, userId)));
  return row?.task;
}

export async function ownedTag(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)));
  return row;
}

export async function ownedComment(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ comment: comments })
    .from(comments)
    .innerJoin(tasks, eq(comments.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(comments.id, id), eq(projects.userId, userId)));
  return row?.comment;
}

export async function ownedAttachment(db: Db, userId: string, id: string) {
  // Two queries instead of one: the exactly-one-parent CHECK means ownership
  // flows through EITHER the task chain or the comment chain, and a dual
  // left-join query buys nothing but noise here.
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row) return undefined;
  const parent = row.taskId
    ? await ownedTask(db, userId, row.taskId)
    : await ownedComment(db, userId, row.commentId as string);
  return parent ? row : undefined;
}

export async function ownedMachine(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.id, id), eq(machines.userId, userId)));
  return row;
}

export async function ownedAssignment(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ assignment: assignments })
    .from(assignments)
    .innerJoin(tasks, eq(assignments.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(assignments.id, id), eq(projects.userId, userId)));
  return row?.assignment;
}

export async function ownedChat(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ chat: chats })
    .from(chats)
    .innerJoin(machines, eq(chats.machineId, machines.id))
    .where(and(eq(chats.id, id), eq(machines.userId, userId)));
  return row?.chat;
}
