import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import * as schema from "../db/schema.js";
import { createStorage } from "../storage.js";

// Same throwaway-container harness as routes.test.ts, plus a Garage container
// (dxflrs/garage — the compose `storage` service) for real S3 round-trips.
// Garage is initialized programmatically through its admin HTTP API: the same
// layout/key/bucket sequence docker/garage/init.sh runs in compose.
let dockerError: string | null = null;
try {
  execSync("docker info", { stdio: "pipe" });
} catch (error) {
  dockerError = error instanceof Error ? error.message : String(error);
}

if (dockerError) {
  console.error(
    `[attachments.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const PG_CONTAINER = `hitch-attachments-pg-test-${process.pid}`;
const GARAGE_CONTAINER = `hitch-attachments-garage-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
// The compose Garage config is reused verbatim — one config to rot.
const GARAGE_TOML = fileURLToPath(new URL("../../../docker/garage/garage.toml", import.meta.url));

const ADMIN_TOKEN = "hitch-test-admin-token";
const RPC_SECRET = "3e1f4dbc7b9a5f20c8d4e6a1b3f5d7092468ace013579bdf2468ace013579bdf";
const ACCESS_KEY_ID = "GKa1b2c3d4e5f60718293a4b5c";
const SECRET_ACCESS_KEY = "7d4f9a2b1c8e5f30d6a4b2c19e7f5d3a8b6c4e2f0a9d7b5c3e1f8a6d4b2c0e9f";
const BUCKET = "hitch-test";
// Tiny cap so the size-cap paths are cheap to exercise.
const MAX_UPLOAD_BYTES = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sha256hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const mappedPort = (container: string, port: number) =>
  execSync(`docker port ${container} ${port}/tcp`, { encoding: "utf8" })
    .split("\n")[0]
    .trim()
    .split(":")
    .pop();

process.env.BETTER_AUTH_SECRET ??= "hitch-test-secret-do-not-use-in-prod";

const USER_A = "user-a";
const USER_B = "user-b";

describeDb("attachments presigned flow (postgres:16 + garage in Docker)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
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

  let taskId: string;
  let commentId: string;

  /** POST /attachments for a task-parented file; returns {attachment, uploadUrl}. */
  const createAttachment = async (bytes: Uint8Array, fields: Record<string, unknown> = {}) => {
    const res = await api(USER_A, "POST", "/attachments", {
      taskId,
      filename: "hello world.png",
      mime: "image/png",
      size: bytes.length,
      sha256: sha256hex(bytes),
      ...fields,
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  beforeAll(async () => {
    // --- postgres ------------------------------------------------------------
    execSync(
      `docker run -d --rm --name ${PG_CONTAINER} ` +
        `-e POSTGRES_PASSWORD=hitch -e POSTGRES_DB=hitch ` +
        `-p 127.0.0.1:0:5432 postgres:16`,
      { stdio: "pipe" },
    );

    // --- garage (single node, admin API init — mirrors docker/garage/init.sh)
    execSync(
      `docker run -d --rm --name ${GARAGE_CONTAINER} ` +
        `-e GARAGE_RPC_SECRET=${RPC_SECRET} -e GARAGE_ADMIN_TOKEN=${ADMIN_TOKEN} ` +
        `-v ${GARAGE_TOML}:/etc/garage.toml:ro ` +
        `-p 127.0.0.1:0:3900 -p 127.0.0.1:0:3903 dxflrs/garage:v1.0.1`,
      { stdio: "pipe" },
    );
    const s3Port = mappedPort(GARAGE_CONTAINER, 3900);
    const adminPort = mappedPort(GARAGE_CONTAINER, 3903);

    const admin = async (path: string, init?: RequestInit) => {
      const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (!res.ok) {
        throw new Error(`garage admin ${path} failed: ${res.status} ${await res.text()}`);
      }
      return res.json() as Promise<any>;
    };

    for (let attempt = 0; ; attempt++) {
      try {
        const health = await fetch(`http://127.0.0.1:${adminPort}/health`);
        if (health.ok) break;
      } catch {
        // not up yet
      }
      if (attempt >= 60) throw new Error("garage container never became ready");
      await sleep(500);
    }

    const status = await admin("/v1/status");
    await admin("/v1/layout", {
      method: "POST",
      body: JSON.stringify([{ id: status.node, zone: "dc1", capacity: 1_000_000_000, tags: [] }]),
    });
    await admin("/v1/layout/apply", { method: "POST", body: JSON.stringify({ version: 1 }) });
    await admin("/v1/key/import", {
      method: "POST",
      body: JSON.stringify({
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        name: "hitch-test",
      }),
    });
    const bucket = await admin("/v1/bucket", {
      method: "POST",
      body: JSON.stringify({ globalAlias: BUCKET }),
    });
    await admin("/v1/bucket/allow", {
      method: "POST",
      body: JSON.stringify({
        bucketId: bucket.id,
        accessKeyId: ACCESS_KEY_ID,
        permissions: { read: true, write: true, owner: true },
      }),
    });

    // --- postgres readiness + app -------------------------------------------
    const pgPort = mappedPort(PG_CONTAINER, 5432);
    const connectionString = `postgres://postgres:hitch@127.0.0.1:${pgPort}/hitch`;
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

    const storage = createStorage({
      endpoint: `http://127.0.0.1:${s3Port}`,
      region: "garage",
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      forcePathStyle: true,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    });
    app = createApp(db, storage);
    await signUp(USER_A);
    await signUp(USER_B);

    const project = await json(
      await api(USER_A, "POST", "/projects", { name: "Attachments", sortOrder: "a0" }),
    );
    taskId = (
      await json(
        await api(USER_A, "POST", "/tasks", {
          projectId: project.id,
          title: "host task",
          sortOrder: "a0",
        }),
      )
    ).id;
    commentId = (
      await json(
        await api(USER_A, "POST", "/comments", { taskId, authorKind: "user", body: "host" }),
      )
    ).id;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    for (const container of [PG_CONTAINER, GARAGE_CONTAINER]) {
      try {
        execSync(`docker rm -f ${container}`, { stdio: "pipe" });
      } catch {
        // Container already gone (e.g. startup failed) — nothing to clean up.
      }
    }
  });

  it("create → upload → finalize → download round-trips the bytes", async () => {
    const bytes = new TextEncoder().encode("attachment bytes, verbatim");
    const { attachment, uploadUrl } = await createAttachment(bytes);
    expect(attachment.state).toBe("pending");
    expect(attachment.key).toMatch(/^attachments\/[0-9a-f-]{36}\/hello_world\.png$/);
    expect(attachment.filename).toBe("hello world.png");

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "image/png" },
    });
    expect(putRes.status).toBe(200);

    const finalizeRes = await api(USER_A, "POST", `/attachments/${attachment.id}/finalize`);
    expect(finalizeRes.status).toBe(200);
    expect((await json(finalizeRes)).state).toBe("finalized");

    // Idempotent re-finalize.
    const again = await api(USER_A, "POST", `/attachments/${attachment.id}/finalize`);
    expect(again.status).toBe(200);
    expect((await json(again)).state).toBe("finalized");

    const downloadRes = await api(USER_A, "GET", `/attachments/${attachment.id}/download`);
    expect(downloadRes.status).toBe(200);
    const { url } = await json(downloadRes);
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);

    const listRes = await api(USER_A, "GET", `/attachments?task_id=${taskId}`);
    expect(listRes.status).toBe(200);
    const listed = await json(listRes);
    expect(listed.map((a: any) => a.id)).toContain(attachment.id);
  });

  it("attaches to a comment parent and lists by comment_id", async () => {
    const bytes = new TextEncoder().encode("comment file");
    const res = await api(USER_A, "POST", "/attachments", {
      commentId,
      filename: "note.txt",
      mime: "text/plain",
      size: bytes.length,
      sha256: sha256hex(bytes),
    });
    expect(res.status).toBe(201);
    const { attachment } = await json(res);
    expect(attachment.commentId).toBe(commentId);
    expect(attachment.taskId).toBeNull();

    const listed = await json(await api(USER_A, "GET", `/attachments?comment_id=${commentId}`));
    expect(listed.map((a: any) => a.id)).toContain(attachment.id);
  });

  it("rejects finalize when the uploaded size does not match the declaration", async () => {
    const declared = new TextEncoder().encode("ten bytes!");
    const { attachment, uploadUrl } = await createAttachment(declared);

    // Garage refuses the mismatched PUT outright (content-length is
    // signature-bound), so no object lands; other S3 implementations may
    // accept it, in which case finalize's HEAD catches the mismatch. Either
    // way finalize must reject.
    await fetch(uploadUrl, {
      method: "PUT",
      body: new Uint8Array(25),
      headers: { "content-type": "image/png" },
    });

    const finalizeRes = await api(USER_A, "POST", `/attachments/${attachment.id}/finalize`);
    expect(finalizeRes.status).toBe(400);

    // Row stays pending → download refuses too.
    const downloadRes = await api(USER_A, "GET", `/attachments/${attachment.id}/download`);
    expect(downloadRes.status).toBe(400);
  });

  it("rejects finalize when nothing was uploaded", async () => {
    const { attachment } = await createAttachment(new TextEncoder().encode("never uploaded"));
    const finalizeRes = await api(USER_A, "POST", `/attachments/${attachment.id}/finalize`);
    expect(finalizeRes.status).toBe(400);
    expect((await json(finalizeRes)).error).toMatch(/not been uploaded/);
  });

  it("rejects create when the declared size exceeds the cap", async () => {
    const res = await api(USER_A, "POST", "/attachments", {
      taskId,
      filename: "big.bin",
      mime: "application/octet-stream",
      size: MAX_UPLOAD_BYTES + 1,
      sha256: "0".repeat(64),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/cap/);
  });

  it("rejects create with both or neither of taskId/commentId", async () => {
    const base = { filename: "x.txt", mime: "text/plain", size: 1, sha256: "0".repeat(64) };
    const both = await api(USER_A, "POST", "/attachments", { ...base, taskId, commentId });
    expect(both.status).toBe(400);
    const neither = await api(USER_A, "POST", "/attachments", base);
    expect(neither.status).toBe(400);
  });

  it("404s another user's attachment (finalize/download/delete/list)", async () => {
    const bytes = new TextEncoder().encode("mine, not yours");
    const { attachment, uploadUrl } = await createAttachment(bytes);
    await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "image/png" },
    });

    expect((await api(USER_B, "POST", `/attachments/${attachment.id}/finalize`)).status).toBe(404);
    expect((await api(USER_B, "GET", `/attachments/${attachment.id}/download`)).status).toBe(404);
    expect((await api(USER_B, "DELETE", `/attachments/${attachment.id}`)).status).toBe(404);
    expect((await api(USER_B, "GET", `/attachments?task_id=${taskId}`)).status).toBe(404);

    // Owner still finalizes fine afterwards.
    expect((await api(USER_A, "POST", `/attachments/${attachment.id}/finalize`)).status).toBe(200);
  });

  it("delete removes the row and the S3 object", async () => {
    const bytes = new TextEncoder().encode("short-lived");
    const { attachment, uploadUrl } = await createAttachment(bytes);
    await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "image/png" },
    });
    expect((await api(USER_A, "POST", `/attachments/${attachment.id}/finalize`)).status).toBe(200);

    // Mint a download URL BEFORE deleting — proves the object itself is gone
    // afterwards, not just the row.
    const { url } = await json(await api(USER_A, "GET", `/attachments/${attachment.id}/download`));
    expect((await fetch(url)).status).toBe(200);

    const deleteRes = await api(USER_A, "DELETE", `/attachments/${attachment.id}`);
    expect(deleteRes.status).toBe(200);

    const listed = await json(await api(USER_A, "GET", `/attachments?task_id=${taskId}`));
    expect(listed.map((a: any) => a.id)).not.toContain(attachment.id);
    expect((await api(USER_A, "GET", `/attachments/${attachment.id}/download`)).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
  });
});
