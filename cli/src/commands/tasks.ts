import { ensureOk, requireSession, type Session } from "../api.js";
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
  fetchTags,
  prependSortOrder,
  resolveProjectForAdd,
  resolveProjectRef,
  resolveTagByName,
  resolveTaskRef,
  tagNames,
  type TaskRow,
} from "../resolvers.js";

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

// The --json projection: the server row plus resolved tag names (agents want
// names, not uuids — tagIds stay for joining against \`tags list --json\`).
function taskJson(task: TaskRow, allTags: { id: string; name: string }[]) {
  return { ...task, tags: tagNames(task.tagIds, allTags as never) };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function list(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(
    args,
    {
      project: { type: "string" },
      status: { type: "string" },
      tag: { type: "string" },
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

  const session = requireSession();
  const project = values.project ? await resolveProjectRef(session, values.project) : undefined;
  const tag = values.tag ? await resolveTagByName(session, values.tag) : undefined;

  // Status filters client-side: the fetch stays status-free so the printed
  // short-id prefixes are unique across open AND done (a prefix copied from
  // an open listing must not collide with a hidden done task).
  const query: Record<string, string> = {};
  if (project) query.project_id = project.id;
  if (tag) query.tag_id = tag.id;
  const res = await session.client.tasks.$get({ query });
  await ensureOk(session, res, "Listing tasks");
  const fetched = (await res.json()) as TaskRow[];
  const rows = status === "all" ? fetched : fetched.filter((t) => t.status === status);

  const allTags = await fetchTags(session);
  if (values.json) {
    printJson(rows.map((t) => taskJson(t, allTags)));
    return;
  }

  if (rows.length === 0) {
    const scope = project ? ` in ${project.name}` : "";
    const withTag = tag ? ` tagged '${tag.name}'` : "";
    if (status === "open") {
      console.log(`No open tasks${scope}${withTag}. (--status all includes done tasks.)`);
    } else if (status === "done") {
      console.log(`No done tasks${scope}${withTag}.`);
    } else {
      console.log(`No tasks${scope}${withTag} yet. Create one: hitch tasks add "Your first task"`);
    }
    return;
  }

  const allIds = fetched.map((t) => t.id);
  // Without a --project scope, group rows by project for readability (the
  // sort is stable, so each project keeps its server-side ordering).
  let display = rows;
  let projectName: (t: TaskRow) => string = () => "";
  if (!project) {
    const projects = await fetchProjects(session);
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    projectName = (t) => (t.projectId ? (byId.get(t.projectId) ?? "?") : "");
    display = rows.slice().sort((a, b) => projectName(a).localeCompare(projectName(b)));
  }

  const headers = ["ID", "TITLE", "TAGS", "STATUS", ...(project ? [] : ["PROJECT"])];
  const table = display.map((t) => [
    shortId(t.id, allIds),
    truncate(t.title, 56),
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
  const allTags = await fetchTags(session);
  if (values.json) {
    printJson(taskJson(task, allTags));
    return;
  }
  const projects = await fetchProjects(session);
  const projectName = projects.find((p) => p.id === task.projectId)?.name ?? "?";
  const names = tagNames(task.tagIds, allTags);
  const lines = [
    task.title,
    "",
    `id:       ${task.id}`,
    `project:  ${projectName}`,
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
  const sortOrder = await prependSortOrder(session, project.id);

  const res = await session.client.tasks.$post({
    json: { projectId: project.id, title, body, sortOrder },
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
    printJson({ ...task, tags: tagRows.map((t) => t.name) });
    return;
  }
  const tagsNote = tagRows.length ? `  [${tagRows.map((t) => t.name).join(", ")}]` : "";
  console.log(`Added ${shortId(task.id, [task.id])} "${truncate(title, 60)}" to ${project.name}${tagsNote}`);
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
    if (values.json) printJson(taskJson(task, await fetchTags(session)));
    else console.log(`Already ${status === "done" ? "done" : "open"}: ${label}`);
    return;
  }
  const res = await session.client.tasks[":id"].$patch({
    param: { id: task.id },
    json: { status },
  });
  await ensureOk(session, res, status === "done" ? "Completing the task" : "Reopening the task");
  const updated = (await res.json()) as TaskRow;
  if (values.json) printJson(taskJson(updated, await fetchTags(session)));
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

  const body = await resolveBody(
    { body: values.body, bodyFile: values["body-file"] },
    values.title !== undefined,
  );
  const patch: { title?: string; body?: string } = {};
  if (values.title !== undefined) patch.title = values.title;
  if (body !== undefined) patch.body = body;
  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      "Nothing to change. Pass --title and/or a new body:\n" +
        '  hitch tasks edit 0198c2a4 --title "New title"\n' +
        "  hitch tasks edit 0198c2a4 --body-file notes.md\n" +
        "  cat notes.md | hitch tasks edit 0198c2a4",
    );
  }

  const session = requireSession();
  const task = await resolveTaskRef(session, ref);
  const res = await session.client.tasks[":id"].$patch({ param: { id: task.id }, json: patch });
  await ensureOk(session, res, "Editing the task");
  const updated = (await res.json()) as TaskRow;
  if (values.json) printJson(taskJson(updated, await fetchTags(session)));
  else console.log(`Updated ${shortId(updated.id, [updated.id])} "${truncate(updated.title, 60)}"`);
}
