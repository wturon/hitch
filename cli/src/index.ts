#!/usr/bin/env node
// hitch — the self-teaching CLI for the Hitch V2 server (docs/v2-prd.md,
// "Agent access"). Everything an agent needs to learn the tool is in --help
// and in the error messages themselves; there is no required skill file.
//
// Exit codes: 0 ok · 1 the operation failed · 2 the invocation was wrong.

import { describeNetworkError } from "./api.js";
import { runComments } from "./commands/comments.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runProjects } from "./commands/projects.js";
import { runSections } from "./commands/sections.js";
import { runTags } from "./commands/tags.js";
import { runTasks } from "./commands/tasks.js";
import { CliError, UsageError } from "./errors.js";
import { ROOT_HELP } from "./help.js";

const COMMAND_HINTS: Record<string, string> = {
  task: "tasks",
  todo: "tasks",
  todos: "tasks",
  project: "projects",
  section: "sections",
  comment: "comments",
  tag: "tags",
};

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(ROOT_HELP);
      return;
    case "login":
      return runLogin(rest);
    case "logout":
      return runLogout(rest);
    case "projects":
      return runProjects(rest);
    case "sections":
      return runSections(rest);
    case "tasks":
      return runTasks(rest);
    case "comments":
      return runComments(rest);
    case "tags":
      return runTags(rest);
    default: {
      // Teach the near-misses people actually type before dumping full help.
      const suggestion = COMMAND_HINTS[command];
      const hint = suggestion ? `Did you mean 'hitch ${suggestion}'?\n\n` : "";
      throw new UsageError(`Unknown command '${command}'. ${hint || "\n\n"}${ROOT_HELP}`);
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  const network = describeNetworkError(error);
  if (network) {
    console.error(network);
    process.exit(1);
  }
  console.error(error instanceof CliError ? error.message : String(error));
  process.exit(1);
});
