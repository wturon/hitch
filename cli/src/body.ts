import { readFileSync } from "node:fs";

import { CliError, UsageError } from "./errors.js";

// Task/comment bodies are VERBATIM (capture text is sacred — the server's
// routes pass bodies through untouched, and so does the CLI): no trimming, no
// newline normalization, no transformation of any kind, in any of the three
// input paths (--body, --body-file, piped stdin).

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface BodyFlags {
  body?: string;
  bodyFile?: string;
}

/**
 * Resolve a body from --body / --body-file / piped stdin, in that order.
 * `--body-file -` reads stdin explicitly. Returns undefined when no body was
 * provided (callers decide: add → "", edit → leave unchanged).
 *
 * `hasTitleFlag` guards the one stdin footgun: a script running
 * `hitch tasks edit <id> --title X` with an empty non-TTY stdin must not
 * silently blank the body — empty piped input is ignored when --title (or
 * another explicit change) was given.
 */
export async function resolveBody(flags: BodyFlags, hasTitleFlag = false): Promise<string | undefined> {
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    throw new UsageError(
      "Pass --body OR --body-file, not both. For example:\n" +
        '  hitch tasks add "Fix flaky sync test" --body "Repro: run vitest twice"\n' +
        '  hitch tasks add "Fix flaky sync test" --body-file notes.md',
    );
  }
  if (flags.body !== undefined) return flags.body;
  if (flags.bodyFile !== undefined && flags.bodyFile !== "-") {
    try {
      return readFileSync(flags.bodyFile, "utf8");
    } catch (error) {
      throw new CliError(
        `Could not read --body-file ${flags.bodyFile}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      );
    }
  }
  if (flags.bodyFile === "-" || !process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped === "" && flags.bodyFile !== "-" && hasTitleFlag) return undefined;
    return piped;
  }
  return undefined;
}
