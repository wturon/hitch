import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import type { Db } from "../context.js";

process.env.BETTER_AUTH_SECRET ??= "hitch-test-secret-do-not-use-in-prod";

// /health and credential-less 401s never touch the database, so a stub Db is
// fine here. The full routes (and real sign-in/api-key auth) get
// real-database coverage in routes.test.ts + auth.test.ts.
const app = createApp(null as unknown as Db);

describe("GET /health", () => {
  it("returns 200 with { ok: true } and requires no auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("requireAuth", () => {
  it("401s API routes without credentials", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(401);
  });

  it("401s the retired x-hitch-user-id placeholder header", async () => {
    const res = await app.request("/projects", {
      headers: { "x-hitch-user-id": "user-a" },
    });
    expect(res.status).toBe(401);
  });
});
