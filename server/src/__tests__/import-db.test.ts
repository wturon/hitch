// Integration test for the throwaway importer's --execute path (M1 step 7):
// fixture Convex export → buildPlan → executePlan against a real postgres:16
// container, then verify byte-for-byte bodies, tag links + colors, ordering,
// and the done/completed_at mapping. Harness copied from db.test.ts.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../db/schema.js";
import { executePlan } from "../import/execute.js";
import { buildPlan } from "../import/plan.js";
import { loadFromConvexExport } from "../import/sources.js";

// These tests spin up a throwaway postgres:16 container. If Docker is
// unreachable they are skipped with a clear message instead of failing.
let dockerError: string | null = null;
try {
  execSync("docker info", { stdio: "pipe" });
} catch (error) {
  dockerError = error instanceof Error ? error.message : String(error);
}

if (dockerError) {
  console.error(
    `[import-db.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const CONTAINER_NAME = `hitch-import-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const EXPORT_DIR = fileURLToPath(new URL("./fixtures/import-export", import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("importer --execute (postgres:16 in Docker)", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    execSync(
      `docker run -d --rm --name ${CONTAINER_NAME} ` +
        `-e POSTGRES_PASSWORD=hitch -e POSTGRES_DB=hitch ` +
        `-p 127.0.0.1:0:5432 postgres:16`,
      { stdio: "pipe" },
    );

    const portLine = execSync(`docker port ${CONTAINER_NAME} 5432/tcp`, {
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();
    const port = portLine.split(":").pop();
    const connectionString = `postgres://postgres:hitch@127.0.0.1:${port}/hitch`;

    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      const client = new pg.Client({ connectionString });
      try {
        await client.connect();
        await client.query("SELECT 1");
        await client.end();
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await client.end().catch(() => {});
        await sleep(500);
      }
    }
    if (lastError) {
      throw new Error(`postgres container never became ready: ${String(lastError)}`);
    }

    pool = new pg.Pool({ connectionString });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    await db
      .insert(schema.user)
      .values({ id: "user-will", name: "Will", email: "will@example.com" });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    } catch {
      // Container already gone (e.g. startup failed) — nothing to clean up.
    }
  });

  it("errors clearly when the better-auth user does not exist", async () => {
    const plan = buildPlan(await loadFromConvexExport(EXPORT_DIR, "will@example.com"));
    await expect(executePlan(db, plan, "nobody@example.com")).rejects.toThrow(
      /no better-auth user/,
    );
  });

  it("imports the fixture export end-to-end", async () => {
    const plan = buildPlan(await loadFromConvexExport(EXPORT_DIR, "will@example.com"));
    const result = await executePlan(db, plan, "will@example.com");

    expect(result).toMatchObject({
      userId: "user-will",
      projects: 2,
      tasks: 5,
      tags: 2,
      taskTags: 2,
    });

    // Project tree: two projects in V1 creation order via sort_order.
    const projects = await db
      .select()
      .from(schema.projects)
      .orderBy(asc(schema.projects.sortOrder));
    expect(projects.map((p) => p.name)).toEqual(["Hitch", "Eagle"]);

    // Ordering: sort_order sequence must reproduce the planned V1 order.
    const hitch = projects[0];
    const hitchTasks = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, hitch.id))
      .orderBy(asc(schema.tasks.sortOrder));
    expect(hitchTasks.map((t) => t.title)).toEqual([
      "Legacy in progress task",
      "Fix the sidebar flicker",
      "Ship the importer",
      "Old legacy done task",
    ]);
    // No sections in V1 → every task at project root.
    expect(hitchTasks.every((t) => t.sectionId === null)).toBe(true);

    // Body byte-for-byte: exactly the fixture bytes after the frontmatter
    // block — &#x20; entities and trailing newline untouched.
    const flicker = hitchTasks[1];
    expect(flicker.body).toBe(
      "The sidebar flickers when switching projects.&#x20;\n" +
        "\n" +
        "Repro:\n" +
        "\n" +
        "- open two projects\n" +
        "- switch fast&#x20;\n",
    );

    // Done mapping: completed-at frontmatter → done + parsed completed_at;
    // legacy `status: done` → done + files-row updatedAt.
    const shipped = hitchTasks[2];
    expect(shipped.status).toBe("done");
    expect(shipped.completedAt?.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    const legacyDone = hitchTasks[3];
    expect(legacyDone.status).toBe("done");
    expect(legacyDone.completedAt?.getTime()).toBe(3000);
    expect(hitchTasks[0].status).toBe("open");
    expect(hitchTasks[0].completedAt).toBeNull();

    // Tags: registry colors from tasks/config.json, links on the tagged task.
    const tags = await db.select().from(schema.tags);
    const byName = new Map(tags.map((t) => [t.name, t]));
    expect(byName.get("easy")?.color).toBe("blue");
    expect(byName.get("bug")?.color).toBe("red");
    const links = await db
      .select()
      .from(schema.taskTags)
      .where(eq(schema.taskTags.taskId, flicker.id));
    expect(new Set(links.map((l) => l.tagId))).toEqual(
      new Set([byName.get("easy")?.id, byName.get("bug")?.id]),
    );

    // Idempotency guard: a second --execute for the same user refuses.
    await expect(executePlan(db, plan, "will@example.com")).rejects.toThrow(
      /already has 5 task/,
    );
  });
});
