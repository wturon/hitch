import { describe, expect, it } from "vitest";

import { TABLE_QUERY_KEYS, queryKeysForTable } from "../queryKeys";

describe("queryKeysForTable", () => {
  it("maps every server table to its own coarse key", () => {
    expect(queryKeysForTable("projects")).toEqual(["projects"]);
    expect(queryKeysForTable("sections")).toEqual(["sections"]);
    expect(queryKeysForTable("tasks")).toEqual(["tasks"]);
    expect(queryKeysForTable("tags")).toEqual(["tags"]);
    expect(queryKeysForTable("comments")).toEqual(["comments"]);
    expect(queryKeysForTable("attachments")).toEqual(["attachments"]);
    expect(queryKeysForTable("chats")).toEqual(["chats"]);
    expect(queryKeysForTable("machines")).toEqual(["machines"]);
  });

  it("maps task_tags onto the tasks key (lists embed tagIds)", () => {
    expect(queryKeysForTable("task_tags")).toEqual(["tasks"]);
  });

  it("maps chat_events onto the chats key (events are read alongside a chat)", () => {
    expect(queryKeysForTable("chat_events")).toEqual(["chats"]);
  });

  it("also refetches chats when assignments change", () => {
    // GET /chats denormalises the task a chat is committed to, and that fact
    // lives in assignments — linking a chat changes what /chats reports with no
    // write to the chats table at all. Without this the picker keeps offering a
    // chat that is already spoken for.
    expect(queryKeysForTable("assignments")).toEqual(["assignments", "chats"]);
  });

  it("returns null for tables it does not know", () => {
    expect(queryKeysForTable("session")).toBeNull();
    expect(queryKeysForTable("")).toBeNull();
  });

  it("covers exactly the known tables", () => {
    expect(Object.keys(TABLE_QUERY_KEYS).sort()).toEqual([
      "assignments",
      "attachments",
      "chat_events",
      "chats",
      "comments",
      "machines",
      "projects",
      "sections",
      "tags",
      "task_tags",
      "tasks",
    ]);
  });
});
