import { describe, expect, it } from "vitest";

import type {
  ProjectRow,
  SectionRow,
  TagRow,
  TaskRow,
  Workspace,
} from "../resolvers.js";
import { filterTasks, planTaskEdit } from "../taskOperations.js";

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

const project: ProjectRow = {
  id: "project-a",
  name: "Hitch",
  repoPath: "/code/hitch",
  sortOrder: "a0",
};
const section: SectionRow = {
  id: "doing",
  projectId: project.id,
  name: "In Progress",
  sortOrder: "a0",
};
const bug: TagRow = { id: "bug", name: "bug", color: "red" };
const auth: TagRow = { id: "auth", name: "Auth", color: "blue" };

function workspace(tasks: TaskRow[]): Workspace {
  return {
    tasks,
    projects: [project],
    sections: [section],
    tags: [bug, auth],
    projectById: new Map([[project.id, project]]),
    sectionById: new Map([[section.id, section]]),
    tagById: new Map([
      [bug.id, bug],
      [auth.id, auth],
    ]),
    tagByKey: new Map([
      [bug.name.toLowerCase(), bug],
      [auth.name.toLowerCase(), auth],
    ]),
  };
}

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

  it("searches title and body case-insensitively in stable order", () => {
    expect(
      filterTasks(tasks, {
        status: "all",
        tagIds: [],
        search: "oauth",
      }).map((row) => row.id),
    ).toEqual(["1", "3"]);
  });
});

describe("planTaskEdit", () => {
  const current = task({
    id: "1",
    title: "Fix login",
    body: "original",
    tagIds: [bug.id, auth.id],
  });
  const ws = workspace([current]);

  it("uses canonical existing names in dry-run and reports tags it will create", () => {
    const plan = planTaskEdit(current, ws, {
      noSection: false,
      addTagNames: ["BUG", "active"],
      removeTagNames: [],
      clearTags: false,
    });
    expect(plan.resultingTagNames).toEqual(["bug", "Auth", "active"]);
    expect(plan.tagsToCreate).toEqual(["active"]);
    expect(plan.changes.tags).toEqual(plan.resultingTagNames);
  });

  it("plans content, section, removal, and addition once for preview and write", () => {
    const plan = planTaskEdit(current, ws, {
      title: "Fix OAuth race",
      body: "new body",
      section,
      noSection: false,
      addTagNames: ["active"],
      removeTagNames: ["BUG"],
      clearTags: false,
    });
    expect(plan.patch).toEqual({
      title: "Fix OAuth race",
      body: "new body",
      sectionId: section.id,
    });
    expect(plan.resultingTagNames).toEqual(["Auth", "active"]);
    expect(plan.changes.section).toBe("In Progress");
  });

  it("preserves retained-link order for clear plus add", () => {
    const plan = planTaskEdit(current, ws, {
      noSection: false,
      addTagNames: ["AUTH", "active"],
      removeTagNames: [],
      clearTags: true,
    });
    expect(plan.resultingTagNames).toEqual(["Auth", "active"]);
  });

  it("rejects conflicting tag operations", () => {
    expect(() =>
      planTaskEdit(current, ws, {
        noSection: false,
        addTagNames: ["BUG"],
        removeTagNames: ["bug"],
        clearTags: false,
      }),
    ).toThrow("cannot be added and removed");
  });

  it("rejects an edit with no changes", () => {
    expect(() =>
      planTaskEdit(current, ws, {
        noSection: false,
        addTagNames: [],
        removeTagNames: [],
        clearTags: false,
      }),
    ).toThrow("Nothing to change");
  });
});
