// THROWAWAY V1 → V2 importer CLI (deleted at M5). See docs/v2-prd.md M1 step 7
// and decision D3 (import = tasks only: title, body verbatim, tags, sections,
// order, open/done).
//
//   npm -w @hitch/server run import -- --from-dir <path-to-.hitch/tasks> \
//     --user-email <email> [--project-name <name>] [--execute]
//   npm -w @hitch/server run import -- --from-convex-export <zip-or-dir> \
//     --user-email <email> [--execute]
//
// Default is --dry-run (prints the plan, touches nothing). --execute writes
// directly to DATABASE_URL with Drizzle — run it ONLY against a fresh/quiet
// database; the better-auth user for --user-email must already exist there.
// .zip exports are extracted with the system `unzip` (dev-machine tool, fine
// for a throwaway).

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildPlan, renderPlan } from "./plan.js";
import { loadFromConvexExport, loadFromDir } from "./sources.js";
import type { SourceProject } from "./sources.js";

const USAGE = `V1 → V2 task importer (throwaway; dry-run by default)

  --from-dir <path>            a V1 .hitch/tasks directory (one project)
  --from-convex-export <path>  the Convex prod export (.zip or extracted dir)
  --user-email <email>         REQUIRED. Selects the user: filters the Convex
                               export via its users table, and (--execute)
                               resolves the better-auth user row to own the data
  --project-name <name>        --from-dir only: target project name.
                               Default "Inbox" (a bare tasks dir carries no
                               project identity — the Inbox-is-a-project rule)
  --skip-project <name>        --from-convex-export only, repeatable: exclude a
                               project by name from the plan entirely (e.g. the
                               Hitch project, imported from --from-dir instead
                               because the export zip is stale for it)
  --allow-existing             bypass the refuse-if-user-has-tasks guard so a
                               second --execute can append to the first (the
                               two-pass import). Existing counts still printed.
  --execute                    actually write to DATABASE_URL (fresh DB only,
                               unless --allow-existing)
  --help                       this text`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "from-dir": { type: "string" },
      "from-convex-export": { type: "string" },
      "user-email": { type: "string" },
      "project-name": { type: "string" },
      "skip-project": { type: "string", multiple: true },
      "allow-existing": { type: "boolean", default: false },
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const fromDir = values["from-dir"];
  const fromExport = values["from-convex-export"];
  const userEmail = values["user-email"];
  if ((fromDir === undefined) === (fromExport === undefined)) {
    throw new Error(`pass exactly one of --from-dir / --from-convex-export\n\n${USAGE}`);
  }
  if (!userEmail) {
    throw new Error(`--user-email is required\n\n${USAGE}`);
  }
  if (values["project-name"] !== undefined && fromDir === undefined) {
    throw new Error("--project-name only applies to --from-dir");
  }
  const skipProjects = values["skip-project"] ?? [];
  if (skipProjects.length > 0 && fromExport === undefined) {
    throw new Error("--skip-project only applies to --from-convex-export");
  }
  const allowExisting = values["allow-existing"] ?? false;

  let sources: SourceProject[];
  if (fromDir !== undefined) {
    sources = [await loadFromDir(fromDir, values["project-name"] ?? "Inbox")];
  } else {
    let root = fromExport as string;
    if (root.endsWith(".zip")) {
      const extracted = mkdtempSync(path.join(os.tmpdir(), "hitch-import-"));
      execFileSync("unzip", ["-o", "-q", root, "-d", extracted]);
      root = extracted;
    } else if (!(await stat(root)).isDirectory()) {
      throw new Error(`--from-convex-export expects a .zip or an extracted directory: ${root}`);
    }
    sources = await loadFromConvexExport(root, userEmail);
  }

  const plan = buildPlan(sources, { skipProjects });
  console.log(renderPlan(plan, { allowExisting }));

  if (!values.execute) {
    console.log("\nDRY RUN — nothing written. Pass --execute to import.");
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("--execute needs DATABASE_URL (point it at a FRESH database)");
  }
  // Imported lazily so dry-run never touches (or requires) a database.
  const { db, pool } = await import("../db/index.js");
  const { executePlan } = await import("./execute.js");
  try {
    const result = await executePlan(db, plan, userEmail, { allowExisting });
    console.log(
      `\nEXECUTED for ${userEmail} (${result.userId}): ` +
        `${result.projects} projects, ${result.tasks} tasks, ` +
        `${result.tags} tags, ${result.taskTags} task_tags.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
