import { ensureOk, requireSession } from "../api.js";
import { resolveBody } from "../body.js";
import { UsageError } from "../errors.js";
import { formatTimestamp, printJson, truncate } from "../format.js";
import { COMMENTS_HELP } from "../help.js";
import { shortId } from "../ids.js";
import { onePositional, parseFlags } from "../parse.js";
import { resolveTaskRef } from "../resolvers.js";

interface CommentRow {
  id: string;
  taskId: string;
  authorKind: "user" | "agent";
  assignmentId: string | null;
  body: string;
  createdAt: string;
}

export async function runComments(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(COMMENTS_HELP);
      return;
    case "list":
      return list(rest);
    case "add":
      return add(rest);
    default:
      throw new UsageError(
        `Unknown subcommand 'comments ${sub}'. Valid: list, add.\n\n${COMMENTS_HELP}`,
      );
  }
}

async function list(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(args, {}, COMMENTS_HELP);
  if (values.help) {
    console.log(COMMENTS_HELP);
    return;
  }
  const ref = onePositional(positionals, "task id", "hitch comments list 0198c2a4");
  const session = requireSession();
  const task = await resolveTaskRef(session, ref);
  const res = await session.client.comments.$get({ query: { task_id: task.id } });
  await ensureOk(session, res, "Listing comments");
  const rows = (await res.json()) as CommentRow[];
  if (values.json) {
    printJson(rows);
    return;
  }
  const label = `${shortId(task.id, [task.id])} "${truncate(task.title, 60)}"`;
  if (rows.length === 0) {
    console.log(`No comments on ${label}. Add one:\n  hitch comments add ${shortId(task.id, [task.id])} --body "..."`);
    return;
  }
  const blocks = rows.map(
    (c) => `[${c.authorKind}] ${formatTimestamp(c.createdAt)}\n${c.body}`,
  );
  console.log(`${rows.length} comment${rows.length === 1 ? "" : "s"} on ${label}\n\n${blocks.join("\n\n")}`);
}

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseFlags(
    args,
    {
      body: { type: "string" },
      "as-agent": { type: "boolean", default: false },
    },
    COMMENTS_HELP,
  );
  if (values.help) {
    console.log(COMMENTS_HELP);
    return;
  }
  const ref = onePositional(
    positionals,
    "task id",
    'hitch comments add 0198c2a4 --body "Shipped in PR #12" --as-agent',
  );
  // --body, or piped stdin (markdown-friendly progress notes) — verbatim.
  const body = await resolveBody({ body: values.body });
  if (body === undefined || body === "") {
    throw new UsageError(
      "Missing comment text. For example:\n" +
        '  hitch comments add 0198c2a4 --body "Shipped in PR #12" --as-agent\n' +
        "  git diff --stat | hitch comments add 0198c2a4 --as-agent",
    );
  }

  // Agents identify themselves via --as-agent or HITCH_AGENT=1 in the
  // environment; everything else is authored as the user.
  const authorKind = values["as-agent"] || process.env.HITCH_AGENT === "1" ? "agent" : "user";
  const session = requireSession();
  const task = await resolveTaskRef(session, ref);
  const res = await session.client.comments.$post({
    json: { taskId: task.id, authorKind, body },
  });
  await ensureOk(session, res, "Adding the comment");
  const row = (await res.json()) as CommentRow;
  if (values.json) printJson(row);
  else {
    console.log(
      `Commented on ${shortId(task.id, [task.id])} "${truncate(task.title, 60)}" as ${authorKind}.`,
    );
  }
}
