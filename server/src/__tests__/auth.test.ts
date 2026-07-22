import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import * as schema from "../db/schema.js";

// Same throwaway-container harness as db.test.ts / routes.test.ts. If Docker
// is unreachable these are skipped with a clear message instead of failing.
let dockerError: string | null = null;
try {
  execSync("docker info", { stdio: "pipe" });
} catch (error) {
  dockerError = error instanceof Error ? error.message : String(error);
}

if (dockerError) {
  console.error(
    `[auth.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const CONTAINER_NAME = `hitch-auth-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

process.env.BETTER_AUTH_SECRET ??= "hitch-test-secret-do-not-use-in-prod";

describeDb("better-auth (postgres:16 in Docker)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  const json = async (res: Response) => (await res.json()) as any;

  const postAuth = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const sessionCookie = (res: Response) => {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error("response set no session cookie");
    return setCookie.split(";")[0];
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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    } catch {
      // Container already gone (e.g. startup failed) — nothing to clean up.
    }
  });

  it("signs up, signs in, and reaches protected routes with the session cookie", async () => {
    const credentials = {
      email: "will@test.local",
      password: "a-long-enough-password",
    };

    const signUpRes = await postAuth("sign-up/email", { name: "Will", ...credentials });
    expect(signUpRes.status).toBe(200);

    const signInRes = await postAuth("sign-in/email", credentials);
    expect(signInRes.status).toBe(200);
    const cookie = sessionCookie(signInRes);

    const listRes = await app.request("/projects", { headers: { cookie } });
    expect(listRes.status).toBe(200);
    expect(await json(listRes)).toEqual([]);

    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Signed-in project", sortOrder: "a0" }),
    });
    expect(createRes.status).toBe(201);
    const project = await json(createRes);

    // The row is scoped to the signed-in better-auth user and its user_id is
    // the real better-auth user id from sign-up.
    const signUpBody = await json(signUpRes);
    expect(project.userId).toBe(signUpBody.user.id);
    const listAgain = await json(await app.request("/projects", { headers: { cookie } }));
    expect(listAgain.map((p: any) => p.id)).toEqual([project.id]);
  });

  it("401s the retired x-hitch-user-id header on every protected route", async () => {
    for (const [method, path] of [
      ["GET", "/projects"],
      ["GET", "/tasks"],
      ["GET", "/tags"],
      ["GET", "/machines"],
      ["GET", "/assignments"],
      ["POST", "/projects"],
      ["POST", "/daemon/machines"],
      ["GET", "/daemon/chats?machine_id=00000000-0000-7000-8000-000000000000"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "x-hitch-user-id": "user-a", "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      });
      expect(res.status, `${method} ${path} with placeholder header`).toBe(401);
    }
  });

  it("authenticates with an api key created by a signed-in session (CLI/daemon path)", async () => {
    const credentials = { email: "daemon@test.local", password: "another-long-password" };
    const signUpRes = await postAuth("sign-up/email", { name: "Daemon", ...credentials });
    expect(signUpRes.status).toBe(200);
    const cookie = sessionCookie(signUpRes);

    const projectRes = await app.request("/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Keyed project", sortOrder: "a0" }),
    });
    expect(projectRes.status).toBe(201);
    const project = await json(projectRes);

    // Create the key through better-auth's own endpoint, authed by the session.
    const keyRes = await postAuth("api-key/create", { name: "test-daemon-key" }, { cookie });
    expect(keyRes.status).toBe(200);
    const { key } = await json(keyRes);
    expect(typeof key).toBe("string");

    // The api key ALONE (no cookie) resolves to the same user.
    const listRes = await app.request("/projects", { headers: { "x-api-key": key } });
    expect(listRes.status).toBe(200);
    expect((await json(listRes)).map((p: any) => p.id)).toEqual([project.id]);

    // A garbage key does not.
    const badRes = await app.request("/projects", {
      headers: { "x-api-key": "hitch-not-a-real-key-0000000000000000" },
    });
    expect(badRes.status).toBe(401);
  });

  it("keeps two signed-up users' projects invisible to each other", async () => {
    const mkUser = async (name: string) => {
      const res = await postAuth("sign-up/email", {
        name,
        email: `${name}@isolation.test.local`,
        password: `password-for-${name}`,
      });
      expect(res.status).toBe(200);
      return sessionCookie(res);
    };

    const cookieA = await mkUser("iso-a");
    const cookieB = await mkUser("iso-b");

    const createRes = await app.request("/projects", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ name: "A's secret project", sortOrder: "a0" }),
    });
    expect(createRes.status).toBe(201);
    const project = await json(createRes);

    const listB = await json(await app.request("/projects", { headers: { cookie: cookieB } }));
    expect(listB.map((p: any) => p.id)).not.toContain(project.id);

    const getB = await app.request(`/projects/${project.id}`, { headers: { cookie: cookieB } });
    expect(getB.status).toBe(404);
  });
});
