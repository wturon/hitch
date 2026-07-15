// One-off migrations for the notes-concept deletion (step 1). Convex rejects
// removing a member from a union validator while any row still carries the
// value, so before `v.literal("note")` can leave the linkedType unions in
// schema.ts (chats + commands), every note-typed row must be retired. Run via:
//
//   npx convex run migrations:countNoteLinks    # dry-run inventory
//   npx convex run migrations:retireNoteLinks   # the actual sweep
//
// Both are idempotent (a second run finds 0 rows). Delete this file once the
// notes-deletion PR ships and the schema no longer mentions "note".
import { internalMutation, internalQuery } from "./_generated/server";

// Notes lived at notes/<slug>/index.md; tasks live at tasks/<slug>/task.md.
// Orphan rows exist (NotesView never re-pointed links on slug rename), so the
// sweep goes by TYPE, never by a known path list. A linkedPath that doesn't
// match the note shape keeps its old value — a dangling task link is harmless
// and still unblocks the schema change.
const NOTE_PATH_PATTERN = /^notes\/([^/]+)\/index\.md$/;

function rewriteNotePath(linkedPath: string | undefined): string | undefined {
  if (!linkedPath) return linkedPath;
  const match = NOTE_PATH_PATTERN.exec(linkedPath);
  if (!match) return linkedPath;
  return `tasks/${match[1]}/task.md`;
}

// Dry-run inventory: every row still carrying linkedType "note", both tables.
// Full scans are fine here — the tables are small and this runs once.
export const countNoteLinks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const chats = (await ctx.db.query("chats").collect())
      .filter((chat) => chat.linkedType === "note")
      .map((chat) => ({
        _id: chat._id,
        projectId: chat.projectId,
        linkedPath: chat.linkedPath,
      }));
    const commands = (await ctx.db.query("commands").collect())
      .filter((command) => command.linkedType === "note")
      .map((command) => ({
        _id: command._id,
        projectId: command.projectId,
        linkedPath: command.linkedPath,
      }));
    return { chats, commands };
  },
});

// The sweep: flip every note-typed row to linkedType "task" and re-point its
// linkedPath at the task location the note is becoming. Commands also mirror
// the new linkedPath into the legacy `path` field, matching how task-typed
// commands are written today (chats.ts start-chat inserts: `path` is set iff
// linkedType === "task"). The chats table has no `path` field.
export const retireNoteLinks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const chatRows = (await ctx.db.query("chats").collect()).filter(
      (chat) => chat.linkedType === "note",
    );
    const chats = [];
    for (const chat of chatRows) {
      const after = rewriteNotePath(chat.linkedPath);
      await ctx.db.patch(chat._id, {
        linkedType: "task" as const,
        linkedPath: after,
      });
      chats.push({ _id: chat._id, before: chat.linkedPath, after });
    }

    const commandRows = (await ctx.db.query("commands").collect()).filter(
      (command) => command.linkedType === "note",
    );
    const commands = [];
    for (const command of commandRows) {
      const after = rewriteNotePath(command.linkedPath);
      await ctx.db.patch(command._id, {
        linkedType: "task" as const,
        linkedPath: after,
        path: after,
      });
      commands.push({ _id: command._id, before: command.linkedPath, after });
    }

    return {
      chatsPatched: chats.length,
      commandsPatched: commands.length,
      chats,
      commands,
    };
  },
});
