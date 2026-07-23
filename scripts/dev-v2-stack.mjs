// Bring up the V2 stack for local dev / e2e: the compose server (:3010) plus a
// V2 daemon in FAKE-LAUNCH mode with an isolated chat store. No cmux and no agent
// binary are touched — delegations spawn simulated chats that walk the full
// reconcile loop, so you can drive the API by hand and watch state advance.
//
// Run:   node scripts/dev-v2-stack.mjs
// Stop:  Ctrl-C (kills the daemon; the compose stack is left up).
// Wipe:  docker compose down -v   (from the repo root)
//
// It signs up a throwaway user and mints an api key, then prints it so you can:
//   curl -s -H "x-api-key: $KEY" http://localhost:3010/assignments | jq
//
// Env: HITCH_SERVER_URL (default http://localhost:3010), SKIP_COMPOSE=1 to reuse
// an already-running stack, HITCH_FAKE_LAUNCH_DELAY_MS to tune the fake turn.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

async function authFetch(path, body, cookie) {
  return fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: SERVER_URL, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function mintKey() {
  const email = `dev-v2-${Date.now()}@example.com`;
  const signup = await authFetch("/api/auth/sign-up/email", { name: "Dev V2", email, password: "hitch-e2e-password" });
  if (!signup.ok) throw new Error(`sign-up failed ${signup.status}: ${await signup.text()}`);
  const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  const created = await authFetch("/api/auth/api-key/create", { name: "dev-v2-daemon" }, cookie);
  if (!created.ok) throw new Error(`api-key create failed ${created.status}: ${await created.text()}`);
  const { key } = await created.json();
  if (!key) throw new Error("api-key create returned no key");
  return { key, email };
}

let daemon;
let scratch;
async function shutdown(code = 0) {
  if (daemon) daemon.kill("SIGINT");
  await sleep(400);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
  if (process.env.SKIP_COMPOSE !== "1") {
    console.log("→ docker compose up -d --build");
    run("docker", ["compose", "up", "-d", "--build"]);
  }

  process.stdout.write("→ waiting for server health");
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${SERVER_URL}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    process.stdout.write(".");
    await sleep(1000);
    if (i === 59) throw new Error(`server never healthy at ${SERVER_URL}`);
  }
  console.log(" ok");

  const { key, email } = await mintKey();
  scratch = mkdtempSync(join(tmpdir(), "hitch-dev-v2-"));

  console.log("\n─── V2 fake stack ready ───────────────────────────────────────");
  console.log(`  server:     ${SERVER_URL}`);
  console.log(`  api key:    ${key}`);
  console.log(`  store dir:  ${scratch}  (isolated; wiped on exit)`);
  console.log(`  user:       ${email}`);
  console.log("  try:        " +
    `curl -s -H "x-api-key: ${key}" ${SERVER_URL}/machines | jq`);
  console.log("───────────────────────────────────────────────────────────────\n");

  daemon = spawn("npx", ["tsx", "daemon/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HITCH_SERVER_URL: SERVER_URL,
      HITCH_API_KEY: key,
      HITCH_FAKE_LAUNCH: "1",
      HITCH_APP_SUPPORT_DIR: scratch,
      HITCH_RECONCILE_MS: process.env.HITCH_RECONCILE_MS ?? "2000",
    },
    stdio: "inherit",
  });
  daemon.on("exit", (code) => void shutdown(code ?? 0));
} catch (error) {
  console.error(`\ndev-v2-stack failed: ${String(error)}`);
  await shutdown(1);
}
