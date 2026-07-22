import { requireSession } from "../api.js";
import { UsageError } from "../errors.js";
import { printJson, renderTable } from "../format.js";
import { PROJECTS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { parseFlags } from "../parse.js";
import { fetchProjects } from "../resolvers.js";

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
    default:
      throw new UsageError(`Unknown subcommand 'projects ${sub}'. Valid: list.\n\n${PROJECTS_HELP}`);
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
