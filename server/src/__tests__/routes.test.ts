import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import * as schema from "../db/schema.js";

// Same throwaway-container harness as db.test.ts. If Docker is unreachable
// these are skipped with a clear message instead of failing.
let dockerError: string | null = null;
try {
  execSync("docker info", { stdio: "pipe" });
} catch (error) {
  dockerError = error instanceof Error ? error.message : String(error);
}

if (dockerError) {
  console.error(
    `[routes.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const CONTAINER_NAME = `hitch-routes-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

process.env.BETTER_AUTH_SECRET ??= "hitch-test-secret-do-not-use-in-prod";

const USER_A = "user-a";
const USER_B = "user-b";

describeDb("HTTP routes (postgres:16 in Docker)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  // Session cookie per test user, captured at sign-up (better-auth
  // auto-signs-in on sign-up). Real auth flows are exercised in auth.test.ts;
  // here the cookie is just the ticket into the routes under test.
  const cookies: Record<string, string> = {};

  const signUp = async (key: string) => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: key,
        email: `${key}@test.local`,
        password: `password-for-${key}`,
      }),
    });
    if (res.status !== 200) {
      throw new Error(`sign-up for ${key} failed: ${res.status} ${await res.text()}`);
    }
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error(`sign-up for ${key} returned no session cookie`);
    cookies[key] = setCookie.split(";")[0];
  };

  const api = (userKey: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        cookie: cookies[userKey],
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const json = async (res: Response) => (await res.json()) as any;

  const createProject = async (userId: string, name: string) => {
    const res = await api(userId, "POST", "/projects", { name, sortOrder: "a0" });
    expect(res.status).toBe(201);
    return json(res);
  };

  const createTask = async (
    userId: string,
    projectId: string,
    fields: Record<string, unknown> = {},
  ) => {
    const res = await api(userId, "POST", "/tasks", {
      projectId,
      title: "task",
      sortOrder: "a0",
      ...fields,
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  const registerMachine = async (userId: string, name: string) => {
    const res = await api(userId, "POST", "/daemon/machines", {
      name,
      daemonVersion: "0.0.1-test",
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  beforeAll(async () => {
    execSync(
      `docker run -d --rm --name ${CONTAINER_NAME} ` +
        `-e POSTGRES_PASSWORD=hitch -e POSTGRES_DB=hitch ` +
        `-p 127.0.0.1:0:5432 postgres:16`,
      { stdio: "pipe" },
    );

    const portLine = execSync(`docker port ${CONTAINER_NAME} 5432/tcp`, { encoding: "utf8" })
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
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    app = createApp(db);
    await signUp(USER_A);
    await signUp(USER_B);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    } catch {
      // Container already gone (e.g. startup failed) — nothing to clean up.
    }
  });

  describe("task CRUD happy path", () => {
    it("creates, reads, updates, and deletes a task; body is verbatim; done/reopen manage completed_at", async () => {
      const project = await createProject(USER_A, "CRUD project");

      // Leading/trailing whitespace, tabs, and weird markdown must survive
      // byte-for-byte — capture text is sacred.
      const weirdBody =
        "   \n# heading  \n\n- [ ] item with **bold** and <not-html>\n\ttabbed\ntrailing spaces   \n\n";
      const task = await createTask(USER_A, project.id, {
        title: "Sacred capture",
        body: weirdBody,
      });
      expect(task.body).toBe(weirdBody);
      expect(task.status).toBe("open");
      expect(task.completedAt).toBeNull();

      const getRes = await api(USER_A, "GET", `/tasks/${task.id}`);
      expect(getRes.status).toBe(200);
      expect((await json(getRes)).body).toBe(weirdBody);

      const titleRes = await api(USER_A, "PATCH", `/tasks/${task.id}`, { title: "Renamed" });
      expect(titleRes.status).toBe(200);
      const renamed = await json(titleRes);
      expect(renamed.title).toBe("Renamed");
      expect(renamed.body).toBe(weirdBody);

      const doneRes = await api(USER_A, "PATCH", `/tasks/${task.id}`, { status: "done" });
      expect(doneRes.status).toBe(200);
      const done = await json(doneRes);
      expect(done.status).toBe("done");
      expect(done.completedAt).toEqual(expect.any(String));

      const reopenRes = await api(USER_A, "PATCH", `/tasks/${task.id}`, { status: "open" });
      expect(reopenRes.status).toBe(200);
      const reopened = await json(reopenRes);
      expect(reopened.status).toBe("open");
      expect(reopened.completedAt).toBeNull();

      const deleteRes = await api(USER_A, "DELETE", `/tasks/${task.id}`);
      expect(deleteRes.status).toBe(200);
      expect((await api(USER_A, "GET", `/tasks/${task.id}`)).status).toBe(404);
    });
  });

  describe("cross-user isolation", () => {
    it("hides user A's project and task from user B (404 on read/update/delete)", async () => {
      const project = await createProject(USER_A, "A's project");
      const task = await createTask(USER_A, project.id, { title: "A's task" });

      for (const [method, path, body] of [
        ["GET", `/projects/${project.id}`, undefined],
        ["PATCH", `/projects/${project.id}`, { name: "stolen" }],
        ["DELETE", `/projects/${project.id}`, undefined],
        ["GET", `/tasks/${task.id}`, undefined],
        ["PATCH", `/tasks/${task.id}`, { title: "stolen" }],
        ["DELETE", `/tasks/${task.id}`, undefined],
      ] as const) {
        const res = await api(USER_B, method, path, body);
        expect(res.status, `${method} ${path} as user B`).toBe(404);
      }

      // Lists are scoped too.
      const listRes = await api(USER_B, "GET", "/tasks");
      expect(listRes.status).toBe(200);
      const rows = await json(listRes);
      expect(rows.map((r: any) => r.id)).not.toContain(task.id);

      // And nothing was actually touched.
      const stillThere = await api(USER_A, "GET", `/tasks/${task.id}`);
      expect(stillThere.status).toBe(200);
      expect((await json(stillThere)).title).toBe("A's task");
    });
  });

  describe("assignment ownership split (single-creator-per-table)", () => {
    it("client PATCH rejects daemon-only fields; daemon PATCH rejects client-only fields", async () => {
      const project = await createProject(USER_A, "Split project");
      const task = await createTask(USER_A, project.id);
      const machine = await registerMachine(USER_A, "split-machine");

      const createRes = await api(USER_A, "POST", "/assignments", {
        taskId: task.id,
        machineId: machine.id,
        harness: "claude",
        prompt: "do the thing",
      });
      expect(createRes.status).toBe(201);
      const assignment = await json(createRes);
      expect(assignment.desiredState).toBe("running");
      expect(assignment.observedState).toBe("pending");

      // Client cannot write observations.
      for (const forbidden of [
        { observedState: "done" },
        { chatId: assignment.id },
        { worktree: "/tmp/nope" },
      ]) {
        const res = await api(USER_A, "PATCH", `/assignments/${assignment.id}`, forbidden);
        expect(res.status, `client PATCH ${JSON.stringify(forbidden)}`).toBe(400);
      }

      // Daemon cannot write intent.
      for (const forbidden of [{ desiredState: "stopped" }, { reviewedAt: null }]) {
        const res = await api(USER_A, "PATCH", `/daemon/assignments/${assignment.id}`, forbidden);
        expect(res.status, `daemon PATCH ${JSON.stringify(forbidden)}`).toBe(400);
      }

      // Each side's own fields work.
      const observeRes = await api(USER_A, "PATCH", `/daemon/assignments/${assignment.id}`, {
        observedState: "running",
        worktree: "/tmp/wt",
      });
      expect(observeRes.status).toBe(200);
      const observed = await json(observeRes);
      expect(observed.observedState).toBe("running");
      expect(observed.worktree).toBe("/tmp/wt");

      const stopRes = await api(USER_A, "PATCH", `/assignments/${assignment.id}`, {
        desiredState: "stopped",
      });
      expect(stopRes.status).toBe(200);
      expect((await json(stopRes)).desiredState).toBe("stopped");
    });
  });

  describe("attention queue", () => {
    it("returns waiting_input + unreviewed-done only; reviewed_at ack removes an entry", async () => {
      const project = await createProject(USER_A, "Attention project");
      const task = await createTask(USER_A, project.id);
      const machine = await registerMachine(USER_A, "attention-machine");

      const mkAssignment = async () => {
        const res = await api(USER_A, "POST", "/assignments", {
          taskId: task.id,
          machineId: machine.id,
          harness: "codex",
        });
        expect(res.status).toBe(201);
        return json(res);
      };
      const observe = async (id: string, observedState: string) => {
        const res = await api(USER_A, "PATCH", `/daemon/assignments/${id}`, { observedState });
        expect(res.status).toBe(200);
      };

      const running = await mkAssignment();
      const waiting = await mkAssignment();
      const doneUnreviewed = await mkAssignment();
      const doneReviewed = await mkAssignment();
      const pending = await mkAssignment();
      await observe(running.id, "running");
      await observe(waiting.id, "waiting_input");
      await observe(doneUnreviewed.id, "done");
      await observe(doneReviewed.id, "done");
      const ackRes = await api(USER_A, "PATCH", `/assignments/${doneReviewed.id}`, {
        reviewedAt: new Date().toISOString(),
      });
      expect(ackRes.status).toBe(200);

      const attention1 = await json(
        await api(USER_A, "GET", `/assignments?task_id=${task.id}&attention=true`),
      );
      expect(attention1.map((a: any) => a.id).sort()).toEqual(
        [waiting.id, doneUnreviewed.id].sort(),
      );
      void pending;

      // Acking the remaining done assignment removes it from the queue.
      const ack2 = await api(USER_A, "PATCH", `/assignments/${doneUnreviewed.id}`, {
        reviewedAt: new Date().toISOString(),
      });
      expect(ack2.status).toBe(200);

      const attention2 = await json(
        await api(USER_A, "GET", `/assignments?task_id=${task.id}&attention=true`),
      );
      expect(attention2.map((a: any) => a.id)).toEqual([waiting.id]);
    });
  });

  describe("task tags", () => {
    it("adds/removes tag links and filters the task list by tag_id", async () => {
      const project = await createProject(USER_A, "Tag project");
      const tagged = await createTask(USER_A, project.id, { title: "tagged" });
      const untagged = await createTask(USER_A, project.id, { title: "untagged" });

      const tagRes = await api(USER_A, "POST", "/tags", { name: "urgent", color: "olive" });
      expect(tagRes.status).toBe(201);
      const tag = await json(tagRes);

      const addRes = await api(USER_A, "POST", `/tasks/${tagged.id}/tags/${tag.id}`);
      expect(addRes.status).toBe(201);
      // Idempotent re-add.
      expect((await api(USER_A, "POST", `/tasks/${tagged.id}/tags/${tag.id}`)).status).toBe(201);

      // User B cannot link tags onto A's rows.
      expect((await api(USER_B, "POST", `/tasks/${tagged.id}/tags/${tag.id}`)).status).toBe(404);

      const filtered = await json(
        await api(USER_A, "GET", `/tasks?project_id=${project.id}&tag_id=${tag.id}`),
      );
      expect(filtered.map((t: any) => t.id)).toEqual([tagged.id]);
      void untagged;

      const removeRes = await api(USER_A, "DELETE", `/tasks/${tagged.id}/tags/${tag.id}`);
      expect(removeRes.status).toBe(200);
      // Removing a link that no longer exists is a 404.
      expect((await api(USER_A, "DELETE", `/tasks/${tagged.id}/tags/${tag.id}`)).status).toBe(404);

      const afterRemove = await json(
        await api(USER_A, "GET", `/tasks?project_id=${project.id}&tag_id=${tag.id}`),
      );
      expect(afterRemove).toEqual([]);
    });

    it("embeds tagIds on list/get/create/patch responses, tracking link changes", async () => {
      const project = await createProject(USER_A, "TagIds project");
      const task = await createTask(USER_A, project.id, { title: "with tagIds" });
      // Create responds with the uniform shape even though no links exist yet.
      expect(task.tagIds).toEqual([]);

      const tagA = await json(await api(USER_A, "POST", "/tags", { name: "ids-a", color: "olive" }));
      const tagB = await json(await api(USER_A, "POST", "/tags", { name: "ids-b", color: "rust" }));
      expect((await api(USER_A, "POST", `/tasks/${task.id}/tags/${tagA.id}`)).status).toBe(201);
      expect((await api(USER_A, "POST", `/tasks/${task.id}/tags/${tagB.id}`)).status).toBe(201);

      const got = await json(await api(USER_A, "GET", `/tasks/${task.id}`));
      expect(got.tagIds.sort()).toEqual([tagA.id, tagB.id].sort());

      const listed = await json(await api(USER_A, "GET", `/tasks?project_id=${project.id}`));
      const listedTask = listed.find((t: any) => t.id === task.id);
      expect(listedTask.tagIds.sort()).toEqual([tagA.id, tagB.id].sort());

      // Patch responses carry the current links alongside the updated row.
      const patched = await json(await api(USER_A, "PATCH", `/tasks/${task.id}`, { title: "re" }));
      expect(patched.title).toBe("re");
      expect(patched.tagIds.sort()).toEqual([tagA.id, tagB.id].sort());

      // Unlink shows up on the next read.
      expect((await api(USER_A, "DELETE", `/tasks/${task.id}/tags/${tagA.id}`)).status).toBe(200);
      const afterUnlink = await json(await api(USER_A, "GET", `/tasks/${task.id}`));
      expect(afterUnlink.tagIds).toEqual([tagB.id]);
    });
  });

  describe("CORS", () => {
    it("answers a renderer-style preflight with wildcard origin + x-api-key header", async () => {
      const res = await app.request("/tasks", {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-api-key",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-api-key");
    });
  });

  describe("comments", () => {
    it("creates and lists comments by task", async () => {
      const project = await createProject(USER_A, "Comment project");
      const task = await createTask(USER_A, project.id);

      const createRes = await api(USER_A, "POST", "/comments", {
        taskId: task.id,
        authorKind: "user",
        body: "  verbatim comment body  ",
      });
      expect(createRes.status).toBe(201);
      const comment = await json(createRes);
      expect(comment.body).toBe("  verbatim comment body  ");

      const listRes = await api(USER_A, "GET", `/comments?task_id=${task.id}`);
      expect(listRes.status).toBe(200);
      const rows = await json(listRes);
      expect(rows.map((r: any) => r.id)).toEqual([comment.id]);

      // User B can't list comments on A's task.
      expect((await api(USER_B, "GET", `/comments?task_id=${task.id}`)).status).toBe(404);
    });
  });
});
