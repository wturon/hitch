import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import type { Db } from "../context.js";

// /health never touches the database, so a stub Db is fine here. The full
// routes get real-database coverage in routes.test.ts.
const app = createApp(null as unknown as Db);

describe("GET /health", () => {
  it("returns 200 with { ok: true } and requires no auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("auth placeholder", () => {
  it("401s API routes without the x-hitch-user-id header", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(401);
  });
});
