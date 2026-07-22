// Unit tests for the throwaway V1 → V2 importer's parsers (M1 step 7).
// Fixtures mirror the REAL V1 shapes: `.hitch/tasks/<slug>/task.md` with flat
// YAML frontmatter, and the Convex prod export's files/projects/users JSONL.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTagsValue } from "../import/frontmatter.js";
import { parseTagConfig, parseTaskFile } from "../import/parse.js";
import { buildPlan, renderPlan } from "../import/plan.js";
import { loadFromConvexExport, loadFromDir } from "../import/sources.js";

const TASKS_DIR = fileURLToPath(new URL("./fixtures/import-tasks", import.meta.url));
const EXPORT_DIR = fileURLToPath(new URL("./fixtures/import-export", import.meta.url));

const file = (path: string, content: string, updatedAtMs = 1000) => ({
  path,
  content,
  updatedAtMs,
});

describe("parseTaskFile", () => {
  it("parses an open task: title, verbatim body, normalized deduped tags", () => {
    const body = "Line one.&#x20;\n\ntrailing newline preserved\n";
    const outcome = parseTaskFile(
      file("tasks/my-task/task.md", `---\ntitle: My task\ntags: Easy, bug, easy\n---\n${body}`),
    );
    expect(outcome.kind).toBe("task");
    if (outcome.kind !== "task") return;
    expect(outcome.task).toMatchObject({
      slug: "my-task",
      title: "My task",
      status: "open",
      completedAtMs: null,
      tags: ["easy", "bug"],
    });
    expect(outcome.task.body).toBe(body);
  });

  it("maps completed-at presence to done and parses the timestamp", () => {
    const outcome = parseTaskFile(
      file(
        "tasks/t/task.md",
        "---\ntitle: T\ncompleted-at: 2026-07-01T12:00:00.000Z\n---\nbody\n",
      ),
    );
    if (outcome.kind !== "task") throw new Error("expected task");
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.completedAtMs).toBe(Date.parse("2026-07-01T12:00:00.000Z"));
  });

  it("presence beats parseability: junk completed-at is still done (null date)", () => {
    const outcome = parseTaskFile(
      file("tasks/t/task.md", "---\ntitle: T\ncompleted-at: not-a-date\n---\nbody\n"),
    );
    if (outcome.kind !== "task") throw new Error("expected task");
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.completedAtMs).toBeNull();
  });

  it("maps legacy `status: done` to done with updatedAt as completed_at", () => {
    const outcome = parseTaskFile(
      file("tasks/t/task.md", "---\ntitle: T\nstatus: done\n---\nbody\n", 3000),
    );
    if (outcome.kind !== "task") throw new Error("expected task");
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.completedAtMs).toBe(3000);
  });

  it("maps other legacy statuses (to-do, In Progress, review…) to open", () => {
    for (const status of ["to-do", "todo", "In Progress", "on-deck", "review", "prioritized"]) {
      const outcome = parseTaskFile(
        file("tasks/t/task.md", `---\ntitle: T\nstatus: ${status}\n---\nbody\n`),
      );
      if (outcome.kind !== "task") throw new Error("expected task");
      expect(outcome.task.status).toBe("open");
      expect(outcome.task.completedAtMs).toBeNull();
    }
  });

  it("skips archived tasks (archived-at or legacy status: archived)", () => {
    for (const fm of ["archived-at: 2026-07-01T00:00:00.000Z", "status: archived"]) {
      const outcome = parseTaskFile(file("tasks/t/task.md", `---\ntitle: T\n${fm}\n---\nbody\n`));
      expect(outcome.kind).toBe("skipped");
    }
  });

  it("skips non-canonical paths (loose .md under tasks/) like V1 does", () => {
    const outcome = parseTaskFile(file("tasks/loose-note.md", "not a card\n"));
    expect(outcome.kind).toBe("skipped");
  });

  it("handles a file with no frontmatter: slug title, whole content as body", () => {
    const content = "Just a body with no frontmatter at all.\n";
    const outcome = parseTaskFile(file("tasks/no-frontmatter/task.md", content));
    if (outcome.kind !== "task") throw new Error("expected task");
    expect(outcome.task.title).toBe("no-frontmatter");
    expect(outcome.task.body).toBe(content);
  });
});

describe("parseTagsValue / parseTagConfig", () => {
  it("splits the flat comma scalar, normalizing to kebab ids", () => {
    expect(parseTagsValue("Needs Judgement, easy")).toEqual(["needs-judgement", "easy"]);
    expect(parseTagsValue(undefined)).toEqual([]);
    expect(parseTagsValue("  , ,")).toEqual([]);
  });

  it("reads the real tasks/config.json shape and survives junk", () => {
    const colors = parseTagConfig(
      '{"version":1,"tags":[{"id":"easy","color":"blue"},{"id":"note","color":"gray"}]}',
    );
    expect(colors.get("easy")).toBe("blue");
    expect(colors.get("note")).toBe("gray");
    expect(parseTagConfig("not json").size).toBe(0);
    expect(parseTagConfig(undefined).size).toBe(0);
  });
});

describe("loadFromDir", () => {
  it("reads a .hitch/tasks dir: task folders, config.json, byte-identical content", async () => {
    const source = await loadFromDir(TASKS_DIR, "Inbox");
    expect(source.name).toBe("Inbox");
    expect(source.files.map((f) => f.path).sort()).toEqual([
      "tasks/archived-idea/task.md",
      "tasks/fix-the-sidebar-flicker/task.md",
      "tasks/no-frontmatter/task.md",
      "tasks/ship-the-importer/task.md",
    ]);
    expect(source.tagConfigJson).toContain('"easy"');

    const raw = await readFile(`${TASKS_DIR}/fix-the-sidebar-flicker/task.md`, "utf8");
    const loaded = source.files.find((f) => f.path === "tasks/fix-the-sidebar-flicker/task.md");
    expect(loaded?.content).toBe(raw);
  });

  it("plans the dir with tag colors from config.json and archived skipped", () => {
    return loadFromDir(TASKS_DIR, "Inbox").then((source) => {
      const plan = buildPlan([source]);
      expect(plan.taskCount).toBe(3);
      expect(plan.doneCount).toBe(1);
      expect(plan.skippedCount).toBe(1);
      expect(plan.tagColors.get("easy")).toBe("blue");
      expect(plan.tagColors.get("bug")).toBe("red");
      expect(plan.projects[0].skipped[0].path).toBe("tasks/archived-idea/task.md");
    });
  });
});

describe("loadFromConvexExport + buildPlan", () => {
  it("filters to one user, drops tombstones, keeps per-project structure", async () => {
    const sources = await loadFromConvexExport(EXPORT_DIR, "will@example.com");
    expect(sources.map((s) => s.name)).toEqual(["Hitch", "Eagle"]); // createdAt asc
    const hitch = sources[0];
    expect(hitch.files.map((f) => f.path)).not.toContain("tasks/deleted-task/task.md");
    expect(hitch.files.map((f) => f.path)).not.toContain("tasks/their-task/task.md");
    expect(hitch.tagConfigJson).toContain('"easy"');
    expect(hitch.ignoredNonTaskFiles).toBe(1); // notes/a-note/index.md
  });

  it("errors clearly on an unknown email", async () => {
    await expect(loadFromConvexExport(EXPORT_DIR, "nobody@example.com")).rejects.toThrow(
      /no user with email/,
    );
  });

  it("preserves V1 ordering: open by updatedAt desc, then done by completed_at desc", async () => {
    const plan = buildPlan(await loadFromConvexExport(EXPORT_DIR, "will@example.com"));
    const hitch = plan.projects.find((p) => p.name === "Hitch");
    expect(hitch?.tasks.map((t) => t.slug)).toEqual([
      "legacy-in-progress", // open, updatedAt 6000
      "fix-the-sidebar-flicker", // open, updatedAt 5000
      "ship-the-importer", // done 2026-07-01
      "old-legacy-done", // done, legacy → updatedAt 3000
    ]);
    expect(plan.taskCount).toBe(5); // + eagle-task
    expect(plan.doneCount).toBe(2);
    expect(plan.taskTagLinkCount).toBe(2);
    expect(plan.skippedCount).toBe(2); // archived-idea + loose-note.md

    const rendered = renderPlan(plan);
    expect(rendered).toContain("projects: 2");
    expect(rendered).toContain("SKIP tasks/loose-note.md");
    expect(rendered).toContain("easy (blue)");
  });
});
