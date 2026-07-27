import { ensureOk, requireSession } from "../api.js";
import { resolveBody } from "../body.js";
import { CliError, UsageError } from "../errors.js";
import { printJson, renderTable, truncate } from "../format.js";
import { TASKS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { onePositional, parseFlags } from "../parse.js";
import {
  ensureTags,
  fetchAllTasks,
  fetchProjects,
  fetchSections,
  fetchTags,
  prependSortOrder,
  resolveProjectForAdd,
  resolveProjectRef,
  resolveSectionRef,
  resolveTagByNameFrom,
  resolveTaskRef,
  tagNames,
  type ProjectRow,
  type SectionRow,
  type TagRow,
  type TaskRow,
} from "../resolvers.js";
import { applyTagEdit, filterTasks, taskContext } from "../taskOperations.js";

export async function runTasks(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(TASKS_HELP);
      return;
    case "list":
      return list(rest);
    case "show":
      return show(rest);
    case "add":
      return add(rest);
    case "done":
      return setStatus(rest, "done");
    case "reopen":
      return setStatus(rest, "open");
    case "edit":
      return edit(rest);
    default:
      throw new UsageError(
        `Unknown subcommand 'tasks ${sub}'. Valid: list, show, add, done, reopen, edit.\n\n${TASKS_HELP}`,
      );
  }
}

// The --json projection keeps ids for joins and also resolves the names agents
// actually reason about.
function taskJson(
  task: TaskRow,
  allTags: TagRow[],
  projects: ProjectRow[],
  sections: SectionRow[],
) {
  return {
    ...task,
    ...taskContext(task, projects, sections),
    tags: tagNames(task.tagIds, allTags),
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function list(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(
    args,
    {
      project: { type: "string" },
      section: { type: "string" },
      status: { type: "string" },
      tag: { type: "string", multiple: true },
      search: { type: "string" },
      limit: { type: "string" },
    },
    TASKS_HELP,
  );
  if (values.help) {
    console.log(TASKS_HELP);
    return;
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `'hitch tasks list' takes flags only. Did you mean:\n` +
        `  hitch tasks list --project ${JSON.stringify(positionals[0])}\n` +
        `  hitch tasks show ${positionals[0]}`,
    );
  }
  const status = values.status ?? "open";
  if (status !== "open" && status !== "done" && status !== "all") {
    throw new UsageError(
      `Invalid --status '${values.status}'. Valid values: open, done, all. For example:\n` +
        `  hitch tasks list --status done`,
    );
  }
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(
        `Invalid --limit '${values.limit}'. Pass a positive integer, for example:\n` +
          "  hitch tasks list --limit 20",
      );
    }
  }
  if (values.section && !values.project) {
    throw new UsageError(
      "--section requires --project so section names have an unambiguous scope. For example:\n" +
        '  hitch tasks list --project Hitch --section "In Progress"',
    );
  }

  const session = requireSession();
  const project = values.project ? await resolveProjectRef(session, values.project) : undefined;
  const [allTasks, allTags, projects, sections] = await Promise.all([
    fetchAllTasks(session),
    fetchTags(session),
    fetchProjects(session),
    fetchSections(session),
  ]);
  const section =
    project && values.section
      ? await resolveSectionRef(session, project, values.section)
      : undefined;
  const tags = (values.tag ?? []).map((name) => resolveTagByNameFrom(allTags, name));
  const rows = filterTasks(allTasks, {
    projectId: project?.id,
    sectionId: section?.id,
    status,
    tagIds: tags.map((tag) => tag.id),
    search: values.search,
    limit,
  });
  if (values.json) {
    printJson(rows.map((task) => taskJson(task, allTags, projects, sections)));
    return;
  }

  if (rows.length === 0) {
    const scope = project ? ` in ${project.name}` : "";
    const inSection = section ? ` / ${section.name}` : "";
    const withTags = tags.length ? ` tagged '${tags.map((tag) => tag.name).join("' and '")}'` : "";
    const matching = values.search ? ` matching '${values.search}'` : "";
    if (status === "open") {
      console.log(
        `No open tasks${scope}${inSection}${withTags}${matching}. ` +
          "(--status all includes done tasks.)",
      );
    } else if (status === "done") {
      console.log(`No done tasks${scope}${inSection}${withTags}${matching}.`);
    } else {
      console.log(
        `No tasks${scope}${inSection}${withTags}${matching} yet. ` +
          'Create one: hitch tasks add "Your first task"',
      );
    }
    return;
  }

  // Always disambiguate against the global task universe: an id copied from a
  // project/tag-scoped listing must resolve later in `tasks show/edit`.
  const allIds = allTasks.map((task) => task.id);
  const projectById = new Map(projects.map((row) => [row.id, row.name]));
  const sectionById = new Map(sections.map((row) => [row.id, row.name]));
  const projectName = (task: TaskRow) =>
    task.projectId ? (projectById.get(task.projectId) ?? "?") : "";
  const sectionName = (task: TaskRow) =>
    task.sectionId ? (sectionById.get(task.sectionId) ?? "?") : "(none)";
  // Without a --project scope, group rows by project for readability (the
  // sort is stable, so each project keeps its server-side ordering).
  const display = project
    ? rows
    : rows.slice().sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const headers = [
    "ID",
    "TITLE",
    "SECTION",
    "TAGS",
    "STATUS",
    ...(project ? [] : ["PROJECT"]),
  ];
  const table = display.map((t) => [
    shortId(t.id, allIds),
    truncate(t.title, 56),
    truncate(sectionName(t), 24),
    truncate(tagNames(t.tagIds, allTags).join(", "), 24),
    t.status,
    ...(project ? [] : [projectName(t)]),
  ]);
  console.log(renderTable(headers, table));
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function show(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(args, {}, TASKS_HELP);
  if (values.help) {
    console.log(TASKS_HELP);
    return;
  }
  const ref = onePositional(positionals, "task id", "hitch tasks show 0198c2a4");
  const session = requireSession();
  const task = await resolveTaskRef(session, ref);
  const [allTags, projects, sections] = await Promise.all([
    fetchTags(session),
    fetchProjects(session),
    fetchSections(session),
  ]);
  if (values.json) {
    printJson(taskJson(task, allTags, projects, sections));
    return;
  }
  const context = taskContext(task, projects, sections);
  const names = tagNames(task.tagIds, allTags);
  const lines = [
    task.title,
    "",
    `id:       ${task.id}`,
    `project:  ${context.project ?? "?"}`,
    `section:  ${context.section ?? "(none)"}`,
    `status:   ${task.status}`,
    `tags:     ${names.length ? names.join(", ") : "(none)"}`,
    `created:  ${task.createdAt}`,
    `updated:  ${task.updatedAt}`,
  ];
  if (task.completedAt) lines.push(`done at:  ${task.completedAt}`);
  lines.push("", task.body === "" ? "(no body)" : task.body);
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(
    args,
    {
      body: { type: "string" },
      "body-file": { type: "string" },
      project: { type: "string" },
      section: { type: "string" },
      tag: { type: "string", multiple: true },
    },
    TASKS_HELP,
  );
  if (values.help) {
    console.log(TASKS_HELP);
    return;
  }
  const title = onePositional(
    positionals,
    "task title",
    'hitch tasks add "Fix flaky sync test" --body "Repro: run vitest twice"',
  );
  if (!title.trim()) {
    throw new UsageError('The task title cannot be empty. For example:\n  hitch tasks add "Fix flaky sync test"');
  }

  const session = requireSession();
  const body = (await resolveBody({ body: values.body, bodyFile: values["body-file"] })) ?? "";
  const project = await resolveProjectForAdd(session, values.project);
  const section = values.section
    ? await resolveSectionRef(session, project, values.section)
    : undefined;
  const sortOrder = await prependSortOrder(session, project.id);

  const res = await session.client.tasks.$post({
    json: { projectId: project.id, sectionId: section?.id, title, body, sortOrder },
  });
  await ensureOk(session, res, "Creating the task");
  let task = (await res.json()) as TaskRow;

  const tagRows = await ensureTags(session, values.tag ?? []);
  for (const tag of tagRows) {
    const link = await session.client.tasks[":id"].tags[":tagId"].$post({
      param: { id: task.id, tagId: tag.id },
    });
    await ensureOk(session, link, `Tagging the task '${tag.name}'`);
  }
  task = { ...task, tagIds: tagRows.map((t) => t.id) };

  if (values.json) {
    printJson({
      ...task,
      project: project.name,
      section: section?.name ?? null,
      tags: tagRows.map((t) => t.name),
    });
    return;
  }
  const tagsNote = tagRows.length ? `  [${tagRows.map((t) => t.name).join(", ")}]` : "";
  const sectionNote = section ? ` / ${section.name}` : "";
  console.log(
    `Added ${shortId(task.id, [task.id])} "${truncate(title, 60)}" ` +
      `to ${project.name}${sectionNote}${tagsNote}`,
  );
}

// ---------------------------------------------------------------------------
// done / reopen
// ---------------------------------------------------------------------------

async function setStatus(args: string[], status: "open" | "done"): Promise<void> {
  const verb = status === "done" ? "done" : "reopen";
  const { values, positionals } = parseFlags(args, {}, TASKS_HELP);
  if (values.help) {
    console.log(TASKS_HELP);
    return;
  }
  const ref = onePositional(positionals, "task id", `hitch tasks ${verb} 0198c2a4`);
  const session = requireSession();
  const task = await resolveTaskRef(session, ref);
  const label = `${shortId(task.id, [task.id])} "${truncate(task.title, 60)}"`;

  if (task.status === status) {
    if (values.json) {
      const [tags, projects, sections] = await Promise.all([
        fetchTags(session),
        fetchProjects(session),
        fetchSections(session),
      ]);
      printJson(taskJson(task, tags, projects, sections));
    } else console.log(`Already ${status === "done" ? "done" : "open"}: ${label}`);
    return;
  }
  const res = await session.client.tasks[":id"].$patch({
    param: { id: task.id },
    json: { status },
  });
  await ensureOk(session, res, status === "done" ? "Completing the task" : "Reopening the task");
  const updated = (await res.json()) as TaskRow;
  if (values.json) {
    const [tags, projects, sections] = await Promise.all([
      fetchTags(session),
      fetchProjects(session),
      fetchSections(session),
    ]);
    printJson(taskJson(updated, tags, projects, sections));
  } else console.log(`${status === "done" ? "Done" : "Reopened"}: ${label}`);
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

async function edit(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(
    args,
    {
      title: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      section: { type: "string" },
      "no-section": { type: "boolean", default: false },
      "add-tag": { type: "string", multiple: true },
      "remove-tag": { type: "string", multiple: true },
      "clear-tags": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    TASKS_HELP,
  );
  if (values.help) {
    console.log(TASKS_HELP);
    return;
  }
  const ref = onePositional(positionals, "task id", 'hitch tasks edit 0198c2a4 --title "New title"');
  if (values.title !== undefined && !values.title.trim()) {
    throw new UsageError(
      'The new title cannot be empty. To change only the body:\n  hitch tasks edit 0198c2a4 --body-file notes.md',
    );
  }
  if (values.section && values["no-section"]) {
    throw new UsageError("Cannot use --section and --no-section together.");
  }
  if (values["clear-tags"] && (values["remove-tag"]?.length ?? 0) > 0) {
    throw new UsageError(
      "Cannot use --clear-tags and --remove-tag together. " +
        "Use --clear-tags with --add-tag to replace the complete set.",
    );
  }
  const addNames = values["add-tag"] ?? [];
  const removeNames = values["remove-tag"] ?? [];
  const invalidTag = [...addNames, ...removeNames].find((name) => !name.trim());
  if (invalidTag !== undefined) throw new UsageError("Tag names cannot be empty.");
  const addKeys = new Set(addNames.map((name) => name.toLowerCase()));
  const overlap = removeNames.find((name) => addKeys.has(name.toLowerCase()));
  if (overlap) {
    throw new UsageError(`Tag '${overlap}' cannot be added and removed in the same edit.`);
  }

  const hasTagEdit = addNames.length > 0 || removeNames.length > 0 || values["clear-tags"];
  const hasExplicitNonBodyChange =
    values.title !== undefined || Boolean(values.section) || values["no-section"] || hasTagEdit;
  const body = await resolveBody(
    { body: values.body, bodyFile: values["body-file"] },
    hasExplicitNonBodyChange,
  );
  const patch: {
    title?: string;
    body?: string;
    sectionId?: string | null;
    tagIds?: string[];
  } = {};
  if (values.title !== undefined) patch.title = values.title;
  if (body !== undefined) patch.body = body;
  if (
    Object.keys(patch).length === 0 &&
    !values.section &&
    !values["no-section"] &&
    !hasTagEdit
  ) {
    throw new UsageError(
      "Nothing to change. Pass content, section, and/or tag flags:\n" +
        '  hitch tasks edit 0198c2a4 --title "New title"\n' +
        "  hitch tasks edit 0198c2a4 --body-file notes.md\n" +
        '  hitch tasks edit 0198c2a4 --section "In Progress"\n' +
        "  hitch tasks edit 0198c2a4 --add-tag active",
    );
  }

  const session = requireSession();
  const task = await resolveTaskRef(session, ref);
  const [projects, sections, allTags] = await Promise.all([
    fetchProjects(session),
    fetchSections(session),
    fetchTags(session),
  ]);
  const project = projects.find((row) => row.id === task.projectId);
  if (!project) {
    throw new CliError(`Task '${task.id}' has no accessible project, so its section cannot be edited.`);
  }
  const section = values.section
    ? await resolveSectionRef(session, project, values.section)
    : undefined;
  if (section) patch.sectionId = section.id;
  else if (values["no-section"]) patch.sectionId = null;

  const removeTags = removeNames.map((name) => resolveTagByNameFrom(allTags, name));
  const existingAddTags = addNames.flatMap((name) => {
    const match = allTags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    return match ? [match] : [];
  });

  if (values["dry-run"]) {
    const currentNames = values["clear-tags"]
      ? []
      : tagNames(task.tagIds, allTags).filter(
          (name) => !removeNames.some((remove) => remove.toLowerCase() === name.toLowerCase()),
        );
    for (const name of addNames) {
      if (!currentNames.some((current) => current.toLowerCase() === name.toLowerCase())) {
        currentNames.push(name);
      }
    }
    const changes = {
      title: patch.title,
      body: patch.body,
      section: section?.name ?? (values["no-section"] ? null : undefined),
      tags: hasTagEdit ? currentNames : undefined,
    };
    if (values.json) printJson({ dryRun: true, taskId: task.id, changes });
    else {
      console.log(
        [
          `Would update ${shortId(task.id, [task.id])} "${truncate(task.title, 60)}":`,
          ...(changes.title !== undefined ? [`  title: ${changes.title}`] : []),
          ...(changes.body !== undefined ? [`  body: ${changes.body.length} characters`] : []),
          ...(changes.section !== undefined
            ? [`  section: ${changes.section ?? "(none)"}`]
            : []),
          ...(changes.tags !== undefined
            ? [`  tags: ${changes.tags.length ? changes.tags.join(", ") : "(none)"}`]
            : []),
        ].join("\n"),
      );
    }
    return;
  }

  if (hasTagEdit) {
    const addedTags =
      existingAddTags.length === addNames.length
        ? existingAddTags
        : await ensureTags(session, addNames);
    patch.tagIds = applyTagEdit(task.tagIds, {
      add: addedTags,
      remove: removeTags,
      clear: values["clear-tags"],
    });
  }

  const res = await session.client.tasks[":id"].$patch({ param: { id: task.id }, json: patch });
  await ensureOk(session, res, "Editing the task");
  const updated = (await res.json()) as TaskRow;
  const updatedTags = hasTagEdit ? await fetchTags(session) : allTags;
  if (values.json) printJson(taskJson(updated, updatedTags, projects, sections));
  else console.log(`Updated ${shortId(updated.id, [updated.id])} "${truncate(updated.title, 60)}"`);
}
