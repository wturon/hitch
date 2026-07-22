import { parseArgs, type ParseArgsConfig } from "node:util";

import { UsageError } from "./errors.js";

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

// Every command gets --json and --help for free; anything unknown becomes a
// UsageError whose message pairs node's complaint ("Unknown option '--x'")
// with the command's usage text — the error itself shows the right invocation.
export function parseFlags<O extends OptionsConfig>(args: string[], options: O, usage: string) {
  try {
    return parseArgs({
      args,
      options: {
        ...options,
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${usage}`);
  }
}

/**
 * The one required positional most subcommands take (a task id/prefix, a
 * title, ...). Missing or surplus positionals throw a UsageError built from
 * `example` — the exact invocation the caller should have typed.
 */
export function onePositional(positionals: string[], what: string, example: string): string {
  if (positionals.length === 0) {
    throw new UsageError(`Missing ${what}. For example:\n  ${example}`);
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `Expected one ${what} but got ${positionals.length} (${positionals.map((p) => JSON.stringify(p)).join(", ")}).\n` +
        `Quote arguments that contain spaces. For example:\n  ${example}`,
    );
  }
  return positionals[0];
}
