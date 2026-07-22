import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../db/schema.js";

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
    `[db.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const CONTAINER_NAME = `hitch-db-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("db schema + migrations + triggers (postgres:16 in Docker)", () => {
  let connectionString: string;
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
    connectionString = `postgres://postgres:hitch@127.0.0.1:${port}/hitch`;

    // Wait for postgres to accept TCP connections from the host. (During
    // initdb it only listens on the container-internal socket, so a
    // successful host connection means init is fully done.)
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    } catch {
      // Container already gone (e.g. startup failed) — nothing to clean up.
    }
  });

  it("applies defaults on insert: uuidv7 id, timestamps, status open", async () => {
    const [project] = await db
      .insert(schema.projects)
      .values({ userId: "user-1", name: "Test project", sortOrder: "a0" })
      .returning();

    expect(project.id).toMatch(UUID_V7_RE);
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);

    const [task] = await db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        title: "Test task",
        body: "Some markdown body",
        sortOrder: "a0",
      })
      .returning();

    expect(task.id).toMatch(UUID_V7_RE);
    expect(task.status).toBe("open");
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.updatedAt).toBeInstanceOf(Date);
    expect(task.completedAt).toBeNull();
  });

  it("advances updated_at via trigger on update", async () => {
    const [task] = await db
      .insert(schema.tasks)
      .values({ title: "Update me", body: "", sortOrder: "a1" })
      .returning();

    // Guard against timestamp ms-rounding making before/after equal.
    await sleep(25);

    const [updated] = await db
      .update(schema.tasks)
      .set({ title: "Updated" })
      .where(eq(schema.tasks.id, task.id))
      .returning();

    expect(updated.updatedAt.getTime()).toBeGreaterThan(task.updatedAt.getTime());
    expect(updated.createdAt.getTime()).toBe(task.createdAt.getTime());
  });

  it("emits a hitch_changes notification with {table, id} on insert", async () => {
    const listener = new pg.Client({ connectionString });
    await listener.connect();
    try {
      const notifications: Array<{ table: string; id: string }> = [];
      let onNotification: (() => void) | undefined;
      listener.on("notification", (message) => {
        if (message.payload) {
          notifications.push(JSON.parse(message.payload));
          onNotification?.();
        }
      });
      await listener.query("LISTEN hitch_changes");

      const [project] = await db
        .insert(schema.projects)
        .values({ userId: "user-1", name: "Notify project", sortOrder: "a2" })
        .returning();

      const deadline = Date.now() + 5_000;
      while (
        !notifications.some((n) => n.table === "projects" && n.id === project.id) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => {
          onNotification = resolve;
          setTimeout(resolve, 100);
        });
      }

      expect(notifications).toContainEqual({ table: "projects", id: project.id });
    } finally {
      await listener.end();
    }
  });

  it("rejects attachments with both or neither of task_id/comment_id", async () => {
    const [task] = await db
      .insert(schema.tasks)
      .values({ title: "Attachment host", body: "", sortOrder: "a3" })
      .returning();
    const [comment] = await db
      .insert(schema.comments)
      .values({ taskId: task.id, authorKind: "user", body: "hi" })
      .returning();

    const base = {
      key: "attachments/abc",
      filename: "a.png",
      mime: "image/png",
      size: 123,
      sha256: "deadbeef",
    };

    // Drizzle wraps the pg error, so the constraint name lives on `cause`.
    const violatesCheck = (error: unknown) =>
      String((error as Error & { cause?: Error })?.cause?.message ?? "").includes(
        "attachments_exactly_one_parent",
      );

    await expect(
      db.insert(schema.attachments).values({ ...base, taskId: task.id, commentId: comment.id }),
    ).rejects.toSatisfy(violatesCheck);

    await expect(db.insert(schema.attachments).values({ ...base })).rejects.toSatisfy(
      violatesCheck,
    );

    // Exactly one parent is accepted.
    const [attachment] = await db
      .insert(schema.attachments)
      .values({ ...base, taskId: task.id })
      .returning();
    expect(attachment.id).toMatch(UUID_V7_RE);
    expect(attachment.state).toBe("pending");
  });

  it("cascades task deletion to tag links, comments, and attachments", async () => {
    const [task] = await db
      .insert(schema.tasks)
      .values({ title: "Doomed task", body: "", sortOrder: "a4" })
      .returning();
    const [tag] = await db
      .insert(schema.tags)
      .values({ userId: "user-1", name: "doomed", color: "olive" })
      .returning();
    await db.insert(schema.taskTags).values({ taskId: task.id, tagId: tag.id });
    const [comment] = await db
      .insert(schema.comments)
      .values({ taskId: task.id, authorKind: "user", body: "bye" })
      .returning();
    await db.insert(schema.attachments).values({
      taskId: task.id,
      key: "attachments/doomed",
      filename: "b.png",
      mime: "image/png",
      size: 1,
      sha256: "cafebabe",
    });
    await db.insert(schema.attachments).values({
      commentId: comment.id,
      key: "attachments/doomed-comment",
      filename: "c.png",
      mime: "image/png",
      size: 1,
      sha256: "cafed00d",
    });

    await db.delete(schema.tasks).where(eq(schema.tasks.id, task.id));

    expect(await db.select().from(schema.taskTags).where(eq(schema.taskTags.taskId, task.id))).toEqual([]);
    expect(await db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))).toEqual([]);
    expect(await db.select().from(schema.attachments).where(eq(schema.attachments.taskId, task.id))).toEqual([]);
    expect(
      await db.select().from(schema.attachments).where(eq(schema.attachments.commentId, comment.id)),
    ).toEqual([]);
    // The tag itself survives — only the link cascades.
    const tagsLeft = await db.select().from(schema.tags).where(eq(schema.tags.id, tag.id));
    expect(tagsLeft).toHaveLength(1);
  });

  it("sets tasks.section_id to NULL when their section is deleted", async () => {
    const [project] = await db
      .insert(schema.projects)
      .values({ userId: "user-1", name: "Sectioned project", sortOrder: "a5" })
      .returning();
    const [section] = await db
      .insert(schema.sections)
      .values({ projectId: project.id, name: "Doomed section", sortOrder: "a0" })
      .returning();
    const [task] = await db
      .insert(schema.tasks)
      .values({
        projectId: project.id,
        sectionId: section.id,
        title: "Survivor",
        body: "",
        sortOrder: "a0",
      })
      .returning();
    expect(task.sectionId).toBe(section.id);

    await db.delete(schema.sections).where(eq(schema.sections.id, section.id));

    const [survivor] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    expect(survivor.sectionId).toBeNull();
    expect(survivor.projectId).toBe(project.id);
  });
});
