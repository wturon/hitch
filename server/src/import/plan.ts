// THROWAWAY (deleted at M5). Source projects → the deterministic import plan:
// parsed tasks in their final per-project order, the user-level tag registry,
// and every skipped file with its reason. Pure — no DB, no IO — so --dry-run
// can print exactly what --execute will write.

import type { ParsedTask, SkippedFile } from "./parse.js";
import { DEFAULT_TAG_COLOR, parseTagConfig, parseTaskFile } from "./parse.js";
import type { SourceProject } from "./sources.js";

export interface PlanProject {
  name: string;
  // Final order = V2 sort_order sequence. V1 has no sections and prod has no
  // manual backlog order rows, so the preserved "V1 ordering" is the rendered
  // default: open tasks by updatedAt desc (Backlog absentee rule), then done
  // tasks by completed_at desc (Done group rule), updatedAt desc tie-break.
  tasks: ParsedTask[];
  skipped: SkippedFile[];
  ignoredNonTaskFiles: number;
}

export interface SkippedProject {
  // A source project excluded from the plan via --skip-project. `taskCount` is
  // what WOULD have imported (parsed, archived/non-card files already dropped),
  // for an honest dry-run tally.
  name: string;
  taskCount: number;
}

export interface ImportPlan {
  projects: PlanProject[];
  // Tag id → named color, user-level (V2 tags are per-user). Colors come from
  // any project's tasks/config.json (first registration wins); unregistered
  // tags get V1's fallback, gray.
  tagColors: Map<string, string>;
  taskCount: number;
  doneCount: number;
  taskTagLinkCount: number;
  skippedCount: number;
  // Projects excluded by name via --skip-project (e.g. Hitch, imported from
  // --from-dir instead). Counted + listed in the dry-run, never written.
  skippedProjects: SkippedProject[];
}

function orderTasks(tasks: ParsedTask[]): ParsedTask[] {
  const open = tasks
    .filter((t) => t.status === "open")
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const done = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0) || b.updatedAtMs - a.updatedAtMs);
  return [...open, ...done];
}

export interface BuildPlanOptions {
  // Source-project names to exclude entirely (matched by exact name). Used so
  // the Hitch project can be imported from --from-dir while everything else
  // comes from the stale export zip. Excluded projects are tallied into
  // `skippedProjects`, never into the writable totals.
  skipProjects?: string[];
}

export function buildPlan(sources: SourceProject[], opts: BuildPlanOptions = {}): ImportPlan {
  const skipSet = new Set(opts.skipProjects ?? []);
  const projects: PlanProject[] = [];
  const skippedProjects: SkippedProject[] = [];
  const tagColors = new Map<string, string>();
  let taskCount = 0;
  let doneCount = 0;
  let taskTagLinkCount = 0;
  let skippedCount = 0;

  for (const source of sources) {
    const registry = parseTagConfig(source.tagConfigJson);
    const tasks: ParsedTask[] = [];
    const skipped: SkippedFile[] = [];

    for (const file of source.files) {
      const outcome = parseTaskFile(file);
      if (outcome.kind === "skipped") {
        skipped.push(outcome.skipped);
        continue;
      }
      tasks.push(outcome.task);
    }

    const ordered = orderTasks(tasks);

    // Excluded by --skip-project: count it for the dry-run, but contribute
    // nothing to the tag registry, totals, or the writable project list.
    if (skipSet.has(source.name)) {
      skippedProjects.push({ name: source.name, taskCount: ordered.length });
      continue;
    }

    for (const task of ordered) {
      for (const tag of task.tags) {
        if (!tagColors.has(tag)) {
          tagColors.set(tag, registry.get(tag) ?? DEFAULT_TAG_COLOR);
        }
      }
      taskTagLinkCount += task.tags.length;
    }

    taskCount += ordered.length;
    doneCount += ordered.filter((t) => t.status === "done").length;
    skippedCount += skipped.length;
    projects.push({
      name: source.name,
      tasks: ordered,
      skipped,
      ignoredNonTaskFiles: source.ignoredNonTaskFiles,
    });
  }

  return {
    projects,
    tagColors,
    taskCount,
    doneCount,
    taskTagLinkCount,
    skippedCount,
    skippedProjects,
  };
}

// Human-readable plan for --dry-run (and echoed before --execute).
export function renderPlan(
  plan: ImportPlan,
  opts: { titlesPerProject?: number; allowExisting?: boolean } = {},
): string {
  const titlesPerProject = opts.titlesPerProject ?? 10;
  const lines: string[] = [];

  lines.push("Import plan");
  lines.push(
    `  projects: ${plan.projects.length}   tasks: ${plan.taskCount} ` +
      `(${plan.taskCount - plan.doneCount} open, ${plan.doneCount} done)   ` +
      `tags: ${plan.tagColors.size}   task_tags: ${plan.taskTagLinkCount}   ` +
      `sections: 0 (V1 has none)   skipped: ${plan.skippedCount}`,
  );

  // Which guard/skip flags shaped this plan (stated even when inactive, so a
  // dry-run reader never has to guess what the writable totals excluded).
  lines.push(
    `  flags: --skip-project ${
      plan.skippedProjects.length > 0
        ? plan.skippedProjects.map((p) => p.name).join(", ")
        : "(none)"
    }   --allow-existing ${opts.allowExisting ? "ON (refuse-if-user-has-tasks guard BYPASSED)" : "off (guard active)"}`,
  );

  if (plan.skippedProjects.length > 0) {
    lines.push("  skipped (--skip-project):");
    for (const p of plan.skippedProjects) {
      lines.push(`    ${p.name} — ${p.taskCount} tasks (not imported from this source)`);
    }
  }

  if (plan.tagColors.size > 0) {
    lines.push("  tag registry:");
    for (const [tag, color] of plan.tagColors) lines.push(`    ${tag} (${color})`);
  }

  for (const project of plan.projects) {
    const done = project.tasks.filter((t) => t.status === "done").length;
    lines.push("");
    lines.push(
      `  ${project.name} — ${project.tasks.length} tasks (${project.tasks.length - done} open, ${done} done)` +
        (project.ignoredNonTaskFiles > 0
          ? `; ${project.ignoredNonTaskFiles} non-task files ignored`
          : ""),
    );
    project.tasks.slice(0, titlesPerProject).forEach((t, i) => {
      const tags = t.tags.length > 0 ? `  [${t.tags.join(", ")}]` : "";
      lines.push(`    ${String(i + 1).padStart(2)}. ${t.status === "done" ? "✓" : "·"} ${t.title}${tags}`);
    });
    if (project.tasks.length > titlesPerProject) {
      lines.push(`    … ${project.tasks.length - titlesPerProject} more`);
    }
    for (const skip of project.skipped) {
      lines.push(`    SKIP ${skip.path} — ${skip.reason}`);
    }
  }

  return lines.join("\n");
}
