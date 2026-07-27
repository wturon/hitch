import { describe, expect, it } from "vitest";

import type { TagRow, TaskRow } from "../resolvers.js";
import { applyTagEdit, filterTasks } from "../taskOperations.js";

const task = ({
  id,
  title,
  ...fields
}: Partial<TaskRow> & Pick<TaskRow, "id" | "title">): TaskRow => ({
  id,
  projectId: "project-a",
  sectionId: null,
  title,
  body: "",
  status: "open",
  sortOrder: "a0",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  completedAt: null,
  tagIds: [],
  ...fields,
});

const tag = (id: string, name: string): TagRow => ({ id, name, color: "blue" });

describe("filterTasks", () => {
  const tasks = [
    task({
      id: "1",
      title: "Fix OAuth callback",
      body: "Reproduce the login race",
      sectionId: "doing",
      tagIds: ["bug", "auth"],
    }),
    task({
      id: "2",
      title: "Write release notes",
      status: "done",
      tagIds: ["docs"],
      sortOrder: "a1",
    }),
    task({
      id: "3",
      title: "Investigate sessions",
      body: "OAuth tokens are stale",
      projectId: "project-b",
      tagIds: ["auth"],
      sortOrder: "a2",
    }),
  ];

  it("composes project, section, status, and AND-tag filters", () => {
    expect(
      filterTasks(tasks, {
        projectId: "project-a",
        sectionId: "doing",
        status: "open",
        tagIds: ["bug", "auth"],
      }).map((row) => row.id),
    ).toEqual(["1"]);
  });

  it("searches title and body case-insensitively, then limits stable order", () => {
    expect(
      filterTasks(tasks, {
        status: "all",
        tagIds: [],
        search: "oauth",
        limit: 1,
      }).map((row) => row.id),
    ).toEqual(["1"]);
  });
});

describe("applyTagEdit", () => {
  const bug = tag("bug", "bug");
  const auth = tag("auth", "auth");
  const active = tag("active", "active");

  it("adds and removes incrementally without duplicating links", () => {
    expect(
      applyTagEdit(["bug", "auth"], {
        add: [active, auth],
        remove: [bug],
        clear: false,
      }),
    ).toEqual(["auth", "active"]);
  });

  it("supports clear plus add as an explicit replacement", () => {
    expect(
      applyTagEdit(["bug", "auth"], {
        add: [active],
        remove: [],
        clear: true,
      }),
    ).toEqual(["active"]);
  });
});
