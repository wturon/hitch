import { describe, expect, it } from "vitest";

import { TABLE_QUERY_KEYS, queryKeyForTable } from "../queryKeys";

describe("queryKeyForTable", () => {
  it("maps every server table to its own coarse key", () => {
    expect(queryKeyForTable("projects")).toEqual(["projects"]);
    expect(queryKeyForTable("sections")).toEqual(["sections"]);
    expect(queryKeyForTable("tasks")).toEqual(["tasks"]);
    expect(queryKeyForTable("tags")).toEqual(["tags"]);
    expect(queryKeyForTable("comments")).toEqual(["comments"]);
    expect(queryKeyForTable("attachments")).toEqual(["attachments"]);
    expect(queryKeyForTable("assignments")).toEqual(["assignments"]);
    expect(queryKeyForTable("chats")).toEqual(["chats"]);
    expect(queryKeyForTable("machines")).toEqual(["machines"]);
  });

  it("maps task_tags onto the tasks key (lists embed tagIds)", () => {
    expect(queryKeyForTable("task_tags")).toEqual(["tasks"]);
  });

  it("returns null for tables it does not know", () => {
    expect(queryKeyForTable("session")).toBeNull();
    expect(queryKeyForTable("")).toBeNull();
  });

  it("covers exactly the known tables", () => {
    expect(Object.keys(TABLE_QUERY_KEYS).sort()).toEqual([
      "assignments",
      "attachments",
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
