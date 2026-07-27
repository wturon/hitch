import type { ProjectRow, SectionRow, TagRow, TaskRow } from "./resolvers.js";

export interface TaskFilters {
  projectId?: string;
  sectionId?: string;
  status: "open" | "done" | "all";
  tagIds: string[];
  search?: string;
  limit?: number;
}

/** Apply the CLI's composable task filters in stable server order. */
export function filterTasks(tasks: readonly TaskRow[], filters: TaskFilters): TaskRow[] {
  const search = filters.search?.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    if (filters.projectId && task.projectId !== filters.projectId) return false;
    if (filters.sectionId && task.sectionId !== filters.sectionId) return false;
    if (filters.status !== "all" && task.status !== filters.status) return false;
    if (!filters.tagIds.every((tagId) => task.tagIds.includes(tagId))) return false;
    if (search && !`${task.title}\n${task.body}`.toLowerCase().includes(search)) return false;
    return true;
  });
  return filters.limit === undefined ? filtered : filtered.slice(0, filters.limit);
}

export function taskContext(
  task: TaskRow,
  projects: readonly ProjectRow[],
  sections: readonly SectionRow[],
) {
  return {
    project: projects.find((project) => project.id === task.projectId)?.name ?? null,
    section: sections.find((section) => section.id === task.sectionId)?.name ?? null,
  };
}

export interface TagEdit {
  add: readonly TagRow[];
  remove: readonly TagRow[];
  clear: boolean;
}

/** Calculate a task's final tag IDs while preserving existing and requested order. */
export function applyTagEdit(currentIds: readonly string[], edit: TagEdit): string[] {
  const removed = new Set(edit.remove.map((tag) => tag.id));
  const next = edit.clear ? [] : currentIds.filter((id) => !removed.has(id));
  for (const tag of edit.add) {
    if (!next.includes(tag.id)) next.push(tag.id);
  }
  return next;
}
