import { UsageError } from "./errors.js";
import {
  resolveTagByName,
  tagKey,
  type SectionRow,
  type TaskRow,
  type Workspace,
} from "./resolvers.js";

export interface TaskFilters {
  projectId?: string;
  sectionId?: string;
  status: "open" | "done" | "all";
  tagIds: string[];
  search?: string;
}

/**
 * Filtering stays client-side deliberately: every printed task prefix must be
 * unique against the same global universe that later show/edit commands use.
 */
export function filterTasks(tasks: readonly TaskRow[], filters: TaskFilters): TaskRow[] {
  const search = filters.search?.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.projectId && task.projectId !== filters.projectId) return false;
    if (filters.sectionId && task.sectionId !== filters.sectionId) return false;
    if (filters.status !== "all" && task.status !== filters.status) return false;
    if (!filters.tagIds.every((tagId) => task.tagIds.includes(tagId))) return false;
    if (search && !`${task.title}\n${task.body}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

export function taskContext(task: TaskRow, workspace: Workspace) {
  return {
    project: workspace.projectById.get(task.projectId)?.name ?? null,
    section: task.sectionId ? (workspace.sectionById.get(task.sectionId)?.name ?? null) : null,
  };
}

export interface TaskEditInput {
  title?: string;
  body?: string;
  section?: SectionRow;
  noSection: boolean;
  addTagNames: readonly string[];
  removeTagNames: readonly string[];
  clearTags: boolean;
}

export interface TaskEditPatch {
  title?: string;
  body?: string;
  sectionId?: string | null;
  tagIds?: string[];
}

export interface TaskEditPlan {
  patch: TaskEditPatch;
  resultingTagNames?: string[];
  tagsToCreate: string[];
  changes: {
    title?: string;
    body?: string;
    section?: string | null;
    tags?: string[];
    tagsToCreate?: string[];
  };
}

type PlannedTag = { id?: string; name: string };

/**
 * The one implementation of edit semantics. Dry-run renders this plan; the
 * write path only materializes unknown tags and submits the plan's patch.
 */
export function planTaskEdit(
  task: TaskRow,
  workspace: Workspace,
  input: TaskEditInput,
): TaskEditPlan {
  if (input.title !== undefined && !input.title.trim()) {
    throw new UsageError(
      "The new title cannot be empty. To change only the body:\n" +
        "  hitch tasks edit 0198c2a4 --body-file notes.md",
    );
  }
  if (input.section && input.noSection) {
    throw new UsageError("Cannot use --section and --no-section together.");
  }
  if (input.clearTags && input.removeTagNames.length > 0) {
    throw new UsageError(
      "Cannot use --clear-tags and --remove-tag together. " +
        "Use --clear-tags with --add-tag to replace the complete set.",
    );
  }
  const invalidTag = [...input.addTagNames, ...input.removeTagNames].find(
    (name) => !name.trim(),
  );
  if (invalidTag !== undefined) throw new UsageError("Tag names cannot be empty.");
  const addKeys = new Set(input.addTagNames.map(tagKey));
  const overlap = input.removeTagNames.find((name) => addKeys.has(tagKey(name)));
  if (overlap) {
    throw new UsageError(`Tag '${overlap}' cannot be added and removed in the same edit.`);
  }

  const patch: TaskEditPatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.section) patch.sectionId = input.section.id;
  else if (input.noSection) patch.sectionId = null;

  const hasTagEdit =
    input.addTagNames.length > 0 || input.removeTagNames.length > 0 || input.clearTags;
  let resultingTags: PlannedTag[] | undefined;
  if (hasTagEdit) {
    const current = task.tagIds.flatMap((id) => {
      const tag = workspace.tagById.get(id);
      return tag ? [{ id: tag.id, name: tag.name }] : [];
    });
    const removed = new Set(
      input.removeTagNames.map((name) => resolveTagByName(workspace, name).id),
    );
    const desired: PlannedTag[] = input.clearTags
      ? []
      : current.filter((tag) => !removed.has(tag.id));
    for (const name of input.addTagNames) {
      const existing = workspace.tagByKey.get(tagKey(name));
      const planned = existing ? { id: existing.id, name: existing.name } : { name };
      if (!desired.some((tag) => tagKey(tag.name) === tagKey(planned.name))) {
        desired.push(planned);
      }
    }

    // The server preserves provenance for retained links and appends new ones.
    // Mirror that persisted order so dry-run, PATCH response, and the next GET
    // all agree even for `--clear-tags --add-tag ...`.
    const desiredKeys = new Set(desired.map((tag) => tagKey(tag.name)));
    const currentKeys = new Set(current.map((tag) => tagKey(tag.name)));
    resultingTags = [
      ...current.filter((tag) => desiredKeys.has(tagKey(tag.name))),
      ...desired.filter((tag) => !currentKeys.has(tagKey(tag.name))),
    ];
  }

  if (Object.keys(patch).length === 0 && resultingTags === undefined) {
    throw new UsageError(
      "Nothing to change. Pass content, section, and/or tag flags:\n" +
        '  hitch tasks edit 0198c2a4 --title "New title"\n' +
        "  hitch tasks edit 0198c2a4 --body-file notes.md\n" +
        '  hitch tasks edit 0198c2a4 --section "In Progress"\n' +
        "  hitch tasks edit 0198c2a4 --add-tag active",
    );
  }

  const resultingTagNames = resultingTags?.map((tag) => tag.name);
  const tagsToCreate = resultingTags?.filter((tag) => !tag.id).map((tag) => tag.name) ?? [];
  return {
    patch,
    resultingTagNames,
    tagsToCreate,
    changes: {
      title: patch.title,
      body: patch.body,
      section: input.section?.name ?? (input.noSection ? null : undefined),
      tags: resultingTagNames,
      tagsToCreate: tagsToCreate.length ? tagsToCreate : undefined,
    },
  };
}
