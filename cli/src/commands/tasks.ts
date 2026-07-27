import { ensureOk, requireSession } from "../api.js";
import { resolveBody } from "../body.js";
import { UsageError } from "../errors.js";
import { printJson, renderTable, truncate } from "../format.js";
import { TASKS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { onePositional, parseFlags } from "../parse.js";
import {
  ensureTags,
  loadWorkspace,
  prependSortOrder,
  resolveProjectForAdd,
  resolveProjectRef,
  resolveSectionRef,
  resolveTagByName,
  resolveTaskRef,
  tagNames,
  type TaskRow,
  type Workspace,
} from "../resolvers.js";
import { filterTasks, planTaskEdit, taskContext } from "../taskOperations.js";

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
function taskJson(task: TaskRow, workspace: Workspace) {
  return {
    ...task,
    ...taskContext(task, workspace),
    tags: tagNames(task.tagIds, workspace),
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
  const session = requireSession();
  const workspace = await loadWorkspace(session);
  let project = values.project ? resolveProjectRef(workspace, values.project) : undefined;
  const section = values.section
    ? resolveSectionRef(workspace, values.section, project)
    : undefined;
  if (!project && section) project = workspace.projectById.get(section.projectId);
  const tags = (values.tag ?? []).map((name) => resolveTagByName(workspace, name));
  const filtered = filterTasks(workspace.tasks, {
    projectId: project?.id,
    sectionId: section?.id,
    status,
    tagIds: tags.map((tag) => tag.id),
    search: values.search,
  });
  const projectName = (task: TaskRow) => workspace.projectById.get(task.projectId)?.name ?? "?";
  const sectionName = (task: TaskRow) =>
    task.sectionId ? (workspace.sectionById.get(task.sectionId)?.name ?? "?") : "(none)";
  // Sort the complete result before limiting so --limit is a real prefix of
  // the same list an unlimited invocation would print.
  const sorted = project
    ? filtered
    : filtered.slice().sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const rows = limit === undefined ? sorted : sorted.slice(0, limit);
  if (values.json) {
    printJson(rows.map((task) => taskJson(task, workspace)));
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
  const allIds = workspace.tasks.map((task) => task.id);
  const headers = [
    "ID",
    "TITLE",
    "SECTION",
    "TAGS",
    "STATUS",
    ...(project ? [] : ["PROJECT"]),
  ];
  const table = rows.map((t) => [
    shortId(t.id, allIds),
    truncate(t.title, 56),
    truncate(sectionName(t), 24),
    truncate(tagNames(t.tagIds, workspace).join(", "), 24),
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
  const workspace = await loadWorkspace(session);
  const task = resolveTaskRef(workspace, ref);
  if (values.json) {
    printJson(taskJson(task, workspace));
    return;
  }
  const context = taskContext(task, workspace);
  const names = tagNames(task.tagIds, workspace);
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
  const workspace = await loadWorkspace(session);
  const project = await resolveProjectForAdd(session, workspace, values.project);
  const section = values.section
    ? resolveSectionRef(workspace, values.section, project)
    : undefined;
  const sortOrder = prependSortOrder(workspace, project.id);

  const res = await session.client.tasks.$post({
    json: { projectId: project.id, sectionId: section?.id, title, body, sortOrder },
  });
  await ensureOk(session, res, "Creating the task");
  let task = (await res.json()) as TaskRow;

  const tagRows = await ensureTags(session, workspace, values.tag ?? []);
  for (const tag of tagRows) {
    const link = await session.client.tasks[":id"].tags[":tagId"].$post({
      param: { id: task.id, tagId: tag.id },
    });
    await ensureOk(session, link, `Tagging the task '${tag.name}'`);
  }
  task = { ...task, tagIds: tagRows.map((t) => t.id) };
  workspace.tasks.unshift(task);

  if (values.json) {
    printJson(taskJson(task, workspace));
    return;
  }
  const tagsNote = tagRows.length ? `  [${tagRows.map((t) => t.name).join(", ")}]` : "";
  const sectionNote = section ? ` / ${section.name}` : "";
  const allIds = workspace.tasks.map((row) => row.id);
  console.log(
    `Added ${shortId(task.id, allIds)} "${truncate(title, 60)}" ` +
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
  const workspace = await loadWorkspace(session);
  const task = resolveTaskRef(workspace, ref);
  const allIds = workspace.tasks.map((row) => row.id);
  const label = `${shortId(task.id, allIds)} "${truncate(task.title, 60)}"`;

  if (task.status === status) {
    if (values.json) printJson(taskJson(task, workspace));
    else console.log(`Already ${status === "done" ? "done" : "open"}: ${label}`);
    return;
  }
  const res = await session.client.tasks[":id"].$patch({
    param: { id: task.id },
    json: { status },
  });
  await ensureOk(session, res, status === "done" ? "Completing the task" : "Reopening the task");
  const updated = (await res.json()) as TaskRow;
  if (values.json) printJson(taskJson(updated, workspace));
  else console.log(`${status === "done" ? "Done" : "Reopened"}: ${label}`);
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
  const addNames = values["add-tag"] ?? [];
  const removeNames = values["remove-tag"] ?? [];
  const hasTagEdit = addNames.length > 0 || removeNames.length > 0 || values["clear-tags"];
  const hasExplicitNonBodyChange =
    values.title !== undefined || Boolean(values.section) || values["no-section"] || hasTagEdit;
  const body = await resolveBody(
    { body: values.body, bodyFile: values["body-file"] },
    hasExplicitNonBodyChange,
  );

  const session = requireSession();
  const workspace = await loadWorkspace(session);
  const task = resolveTaskRef(workspace, ref);
  const project = workspace.projectById.get(task.projectId);
  const section = values.section
    ? resolveSectionRef(workspace, values.section, project)
    : undefined;
  const plan = planTaskEdit(task, workspace, {
    title: values.title,
    body,
    section,
    noSection: values["no-section"],
    addTagNames: addNames,
    removeTagNames: removeNames,
    clearTags: values["clear-tags"],
  });
  const allIds = workspace.tasks.map((row) => row.id);

  if (values["dry-run"]) {
    const changes = {
      title: plan.patch.title,
      body: plan.patch.body,
      section: plan.sectionName,
      tags: plan.resultingTagNames,
      tagsToCreate: plan.tagsToCreate.length ? plan.tagsToCreate : undefined,
    };
    if (values.json) printJson({ dryRun: true, taskId: task.id, changes });
    else {
      console.log(
        [
          `Would update ${shortId(task.id, allIds)} "${truncate(task.title, 60)}":`,
          ...(changes.title !== undefined ? [`  title: ${changes.title}`] : []),
          ...(changes.body !== undefined ? [`  body: ${changes.body.length} characters`] : []),
          ...(changes.section !== undefined
            ? [`  section: ${changes.section ?? "(none)"}`]
            : []),
          ...(changes.tags !== undefined
            ? [
                `  tags: ${changes.tags.length ? changes.tags.join(", ") : "(none)"}`,
              ]
            : []),
          ...(changes.tagsToCreate
            ? [`  creates tags: ${changes.tagsToCreate.join(", ")}`]
            : []),
        ].join("\n"),
      );
    }
    return;
  }

  if (plan.resultingTagNames) {
    const resultingTags = await ensureTags(session, workspace, plan.resultingTagNames);
    plan.patch.tagIds = resultingTags.map((tag) => tag.id);
  }

  const res = await session.client.tasks[":id"].$patch({
    param: { id: task.id },
    json: plan.patch,
  });
  await ensureOk(session, res, "Editing the task");
  const updated = (await res.json()) as TaskRow;
  if (values.json) printJson(taskJson(updated, workspace));
  else console.log(`Updated ${shortId(updated.id, allIds)} "${truncate(updated.title, 60)}"`);
}
