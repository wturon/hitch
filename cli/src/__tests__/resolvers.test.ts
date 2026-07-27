import { describe, expect, it } from "vitest";

import {
  resolveSectionRef,
  resolveTaskRef,
  type ProjectRow,
  type SectionRow,
  type TaskRow,
  type Workspace,
} from "../resolvers.js";

const projects: ProjectRow[] = [
  { id: "project-a", name: "Hitch", repoPath: null, sortOrder: "a0" },
  { id: "project-b", name: "Website", repoPath: null, sortOrder: "a1" },
];

const sections: SectionRow[] = [
  { id: "section-a", projectId: "project-a", name: "Doing", sortOrder: "a0" },
  { id: "section-b", projectId: "project-b", name: "Doing", sortOrder: "a0" },
  { id: "section-c", projectId: "project-b", name: "Review", sortOrder: "a1" },
];

const task = (id: string, projectId: string, title: string): TaskRow => ({
  id,
  projectId,
  sectionId: null,
  title,
  body: "",
  status: "open",
  sortOrder: "a0",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  completedAt: null,
  tagIds: [],
});

function workspace(tasks: TaskRow[]): Workspace {
  return {
    tasks,
    projects,
    sections,
    tags: [],
    projectById: new Map(projects.map((project) => [project.id, project])),
    sectionById: new Map(sections.map((section) => [section.id, section])),
    tagById: new Map(),
    tagByKey: new Map(),
  };
}

describe("pure workspace resolvers", () => {
  it("resolves task prefixes against the global task set", () => {
    const ws = workspace([
      task("abcd1111", "project-a", "First"),
      task("abcd2222", "project-b", "Second"),
    ]);

    expect(resolveTaskRef(ws, "abcd1").title).toBe("First");
    expect(() => resolveTaskRef(ws, "abcd")).toThrow("matches 2 tasks");
  });

  it("infers a section's project when its name is globally unique", () => {
    const ws = workspace([]);

    expect(resolveSectionRef(ws, "review")).toEqual(sections[2]);
  });

  it("requires project scope for duplicate section names", () => {
    const ws = workspace([]);

    expect(() => resolveSectionRef(ws, "doing")).toThrow("2 sections");
    expect(resolveSectionRef(ws, "doing", projects[1])).toEqual(sections[1]);
  });
});
