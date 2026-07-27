import { requireSession } from "../api.js";
import { UsageError } from "../errors.js";
import { printJson, renderTable } from "../format.js";
import { SECTIONS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { parseFlags } from "../parse.js";
import { fetchSections, resolveProjectRef } from "../resolvers.js";

export async function runSections(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(SECTIONS_HELP);
      return;
    case "list":
      return list(rest);
    default:
      throw new UsageError(`Unknown subcommand 'sections ${sub}'. Valid: list.\n\n${SECTIONS_HELP}`);
  }
}

async function list(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(
    args,
    { project: { type: "string" } },
    SECTIONS_HELP,
  );
  if (values.help) {
    console.log(SECTIONS_HELP);
    return;
  }
  if (positionals.length > 0 || !values.project) {
    throw new UsageError(
      "A project is required. For example:\n" +
        "  hitch sections list --project Hitch\n\n" +
        SECTIONS_HELP,
    );
  }
  const session = requireSession();
  const project = await resolveProjectRef(session, values.project);
  const sections = await fetchSections(session, project.id);
  if (values.json) {
    printJson(sections);
    return;
  }
  if (sections.length === 0) {
    console.log(`No sections in ${project.name}.`);
    return;
  }
  const ids = sections.map((section) => section.id);
  console.log(
    renderTable(
      ["ID", "SECTION"],
      sections.map((section) => [shortId(section.id, ids), section.name]),
    ),
  );
}
