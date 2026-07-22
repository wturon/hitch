import { requireSession } from "../api.js";
import { UsageError } from "../errors.js";
import { printJson, renderTable } from "../format.js";
import { TAGS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { parseFlags } from "../parse.js";
import { fetchTags } from "../resolvers.js";

export async function runTags(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(TAGS_HELP);
      return;
    case "list":
      return list(rest);
    default:
      throw new UsageError(`Unknown subcommand 'tags ${sub}'. Valid: list.\n\n${TAGS_HELP}`);
  }
}

async function list(args: string[]): Promise<void> {
  const { values } = parseFlags(args, {}, TAGS_HELP);
  if (values.help) {
    console.log(TAGS_HELP);
    return;
  }
  const session = requireSession();
  const tags = await fetchTags(session);
  if (values.json) {
    printJson(tags);
    return;
  }
  if (tags.length === 0) {
    console.log('No tags yet. Tags are created on the fly: hitch tasks add "..." --tag bug');
    return;
  }
  const ids = tags.map((t) => t.id);
  console.log(
    renderTable(
      ["ID", "NAME", "COLOR"],
      tags.map((t) => [shortId(t.id, ids), t.name, t.color]),
    ),
  );
}
