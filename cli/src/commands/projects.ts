import { requireSession } from "../api.js";
import { UsageError } from "../errors.js";
import { printJson, renderTable } from "../format.js";
import { PROJECTS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { onePositional, parseFlags } from "../parse.js";
import { fetchProjects, loadWorkspace, resolveProjectRef } from "../resolvers.js";

export async function runProjects(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(PROJECTS_HELP);
      return;
    case "list":
      return list(rest);
    case "show":
      return show(rest);
    default:
      throw new UsageError(
        `Unknown subcommand 'projects ${sub}'. Valid: list, show.\n\n${PROJECTS_HELP}`,
      );
  }
}

async function list(args: string[]): Promise<void> {
  const { values } = parseFlags(args, {}, PROJECTS_HELP);
  if (values.help) {
    console.log(PROJECTS_HELP);
    return;
  }
  const session = requireSession();
  const projects = await fetchProjects(session);
  if (values.json) {
    printJson(projects);
    return;
  }
  if (projects.length === 0) {
    console.log('No projects yet. Adding a task creates "Inbox": hitch tasks add "Your first task"');
    return;
  }
  const ids = projects.map((p) => p.id);
  console.log(renderTable(["ID", "NAME"], projects.map((p) => [shortId(p.id, ids), p.name])));
}

async function show(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(args, {}, PROJECTS_HELP);
  if (values.help) {
    console.log(PROJECTS_HELP);
    return;
  }
  const ref = onePositional(positionals, "project name or id", "hitch projects show Hitch");
  const session = requireSession();
  const workspace = await loadWorkspace(session);
  const project = resolveProjectRef(workspace, ref);
  const sections = workspace.sections.filter((section) => section.projectId === project.id);
  const projectTasks = workspace.tasks.filter((task) => task.projectId === project.id);
  const counts = {
    open: projectTasks.filter((task) => task.status === "open").length,
    done: projectTasks.filter((task) => task.status === "done").length,
  };
  if (values.json) {
    printJson({ ...project, sections, taskCounts: counts });
    return;
  }
  console.log(
    [
      project.name,
      "",
      `id:        ${project.id}`,
      `repo:      ${project.repoPath ?? "(none)"}`,
      `open:      ${counts.open}`,
      `done:      ${counts.done}`,
      `sections:  ${sections.length ? sections.map((section) => section.name).join(", ") : "(none)"}`,
      "",
      `List its tasks: hitch tasks list --project ${JSON.stringify(project.name)}`,
    ].join("\n"),
  );
}
