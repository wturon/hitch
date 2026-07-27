// Every help string in one place. These are the product: agents learn the
// tool from exactly this text, so examples use realistic values and every
// flag shown is exact. Keep lines under ~90 chars so terminals don't wrap.

export const ROOT_HELP = `hitch — the Hitch task backlog, from the command line

Hitch is a personal task manager. This CLI is how scripts and coding agents
work the backlog: pull open tasks, add new ones with full markdown bodies,
comment on progress, mark work done.

USAGE
  hitch <command> [flags]

FIRST RUN
  hitch login --server http://localhost:3010
    Sign in once (interactive, or --email/--password for scripts).
    Credentials land in ~/.config/hitch/cli.json.

COMMANDS
  projects list                       every project
  projects show <name-or-id>          one project, its sections, task counts
  sections list --project <project>   a project's sections
  tasks list                          open tasks (--status done|all widens)
  tasks show <id>                     one task in full, body verbatim
  tasks add "<title>"                 create a task (body: --body/--body-file/stdin)
  tasks done <id>                     mark done
  tasks reopen <id>                   back to open
  tasks edit <id>                     change content, section, and/or tags
  comments list <task-id>             a task's comment thread
  comments add <task-id> --body "…"   comment on a task
  tags list                           every tag
  login / logout                      manage credentials

EXAMPLES
  hitch tasks list --project Inbox
  hitch tasks show 0198c2a4
  hitch tasks add "Fix flaky sync test" --body "Repro: run vitest twice" --tag bug
  git log --oneline -20 | hitch tasks add "Write release notes" --project Hitch
  hitch tasks done 0198c2a4
  hitch comments add 0198c2a4 --body "Shipped in PR #12" --as-agent

IDS
  Listings print a short id prefix per row (e.g. 0198c2a4). Any unambiguous
  prefix works wherever an id is expected; ambiguous prefixes fail with the
  list of matches. --json output always carries full uuids.

MACHINE OUTPUT
  Every command accepts --json: stable shapes, full uuids, bodies verbatim.
  Prefer it when parsing output.

Run \`hitch <command> --help\` (e.g. \`hitch tasks --help\`) for details.`;

export const LOGIN_HELP = `hitch login — authenticate against a Hitch server

USAGE
  hitch login --server <url> [--email <email> --password <password>]

Signs in with email/password, mints a CLI API key on the server, and stores
{serverUrl, apiKey} in ~/.config/hitch/cli.json (0600). The password itself
is never stored. Without --email/--password you are prompted interactively.

--server may be omitted when re-logging in to the server already stored.
Accounts are created in the Hitch desktop app (there is no CLI sign-up).

EXAMPLES
  hitch login --server http://localhost:3010
  hitch login --server https://hitch.example.com --email will@example.com --password s3cret`;

export const LOGOUT_HELP = `hitch logout — forget stored credentials

USAGE
  hitch logout

Best-effort revokes the CLI's API key on the server, then deletes
~/.config/hitch/cli.json. Never fails: an unreachable server still logs you
out locally.`;

export const PROJECTS_HELP = `hitch projects — inspect projects

USAGE
  hitch projects list [--json]
  hitch projects show <name-or-id> [--json]

Projects are the top-level buckets tasks live in ("Inbox" is the default).
Use a project's name (case-insensitive) or id with \`hitch tasks list
--project <name-or-id>\` and \`hitch tasks add --project <name-or-id>\`.

EXAMPLES
  hitch projects list
  hitch projects show Hitch
  hitch projects list --json`;

export const SECTIONS_HELP = `hitch sections — inspect a project's sections

USAGE
  hitch sections list --project <name-or-id> [--json]

Section names are resolved within their project, case-insensitively. A section
id or unambiguous id prefix works too.

EXAMPLES
  hitch sections list --project Hitch
  hitch sections list --project 0198c2a4 --json`;

export const TASKS_HELP = `hitch tasks — read and write tasks

USAGE
  hitch tasks list   [--project <name-or-id>] [--section <name-or-id>]
                     [--status open|done|all] [--tag <name>]...
                     [--search <text>] [--limit <n>] [--json]
  hitch tasks show   <id-or-prefix> [--json]
  hitch tasks add    "<title>" [--body <markdown> | --body-file <path>] [--project <name-or-id>]
                     [--section <name-or-id>] [--tag <name>]... [--json]
  hitch tasks done   <id-or-prefix> [--json]
  hitch tasks reopen <id-or-prefix> [--json]
  hitch tasks edit   <id-or-prefix> [--title <title>]
                     [--body <markdown> | --body-file <path>]
                     [--section <name-or-id> | --no-section]
                     [--add-tag <name>]... [--remove-tag <name>]... [--clear-tags]
                     [--dry-run] [--json]

NOTES
  list    shows OPEN tasks by default; --status done or --status all widens it.
          --tag may repeat and uses AND semantics. A unique section id/name can
          infer its project; --project disambiguates repeated section names.
          --search matches title or body, case-insensitively.
  add     defaults to the Inbox project. The body is stored verbatim, so pipe
          markdown straight in: cat notes.md | hitch tasks add "Triage notes"
          --tag may repeat; unknown tags are created automatically.
  edit    piped stdin (or --body/--body-file) REPLACES the body; --title alone
          leaves the body untouched. Added tags are created if necessary.
          --clear-tags may be combined with --add-tag to replace the whole set.
  show    prints metadata, a blank line, then the body verbatim. Use --json
          when you need to parse the body exactly.

EXAMPLES
  hitch tasks list --project Inbox
  hitch tasks list --project Hitch --section "In Progress" --tag bug
  hitch tasks list --status all --search "oauth callback" --limit 20 --json
  hitch tasks add "Upgrade Node" --project Hitch --section Backlog --tag infra
  hitch tasks add "Fix flaky sync test" --body "Repro: run vitest twice in a row"
  hitch tasks show 0198c2a4
  hitch tasks edit 0198c2a4 --section "In Progress" --add-tag active
  hitch tasks done 0198c2a4`;

export const COMMENTS_HELP = `hitch comments — a task's comment thread

USAGE
  hitch comments list <task-id-or-prefix> [--json]
  hitch comments add  <task-id-or-prefix> --body <text> [--as-agent] [--json]

NOTES
  add     --body takes the comment text; piped stdin works too (markdown ok,
          stored verbatim). Comments are authored as "user" unless --as-agent
          is passed or HITCH_AGENT=1 is set — agents leaving progress notes
          should identify themselves with one of those.

EXAMPLES
  hitch comments list 0198c2a4
  hitch comments add 0198c2a4 --body "Shipped in PR #12, awaiting review" --as-agent
  git diff --stat | hitch comments add 0198c2a4 --as-agent`;

export const TAGS_HELP = `hitch tags — list tags

USAGE
  hitch tags list [--json]

Tags are flat labels with a color, shared across projects. They are created
on the fly the first time a task is tagged with a new name:
  hitch tasks add "Fix login redirect" --tag bug

EXAMPLES
  hitch tags list
  hitch tags list --json`;
