// THE M4 acceptance check (PR 6): the full delegate → attention → focus →
// close-on-done loop, UI-driven against the compose server + a FAKE daemon.
// DISPOSABLE, not a maintained suite — see ../../AGENTS.md.
//
// Daemon-spawn approach (documented deviation-free choice): this script runs its
// OWN fake daemon (HITCH_FAKE_LAUNCH=1, isolated HITCH_APP_SUPPORT_DIR, the api
// key minted by the UI sign-up) and DISABLES the app-managed daemon via
// HITCH_DISABLE_APP_DAEMON=1 — so there is exactly one daemon per machine and no
// two-writer contention. The app relays focus over its main-held WS; the fake
// daemon receives it and logs (no cmux). We assert against the daemon's stdout.
//
// Prereqs:
//   - docker running (the script brings compose up unless SKIP_COMPOSE=1)
//   - the Vite dev renderer on :5173 (npm run dev:renderer)
//   - a signed-in dev secrets.json (the harness seeds auth from it)
//
// Run:
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-delegate.mjs
//
// Stages screenshotted into e2e/shots/. `docker compose down -v` runs at the end.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
process.env.HITCH_SERVER_URL = SERVER_URL;
// Deterministic single-daemon: the app must not spawn its own.
process.env.HITCH_DISABLE_APP_DAEMON = "1";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-delegate.log");
writeFileSync(LOG, "");

const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass = true, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(args) {
  const res = spawnSync("docker", ["compose", ...args], { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`docker compose ${args.join(" ")} exited ${res.status}`);
}

const email = `delegate-${Date.now()}@example.com`;
const password = "hitch-e2e-password";

let daemon;
let scratch;
let daemonOut = "";
let cleanupApp = async () => {};

try {
  // ── compose up + health ──────────────────────────────────────────────────
  if (process.env.SKIP_COMPOSE !== "1") {
    log("→ docker compose up -d --build");
    compose(["up", "-d", "--build"]);
  }
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${SERVER_URL}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await sleep(1000);
    if (i === 59) throw new Error(`server never healthy at ${SERVER_URL}`);
  }
  log(`server healthy at ${SERVER_URL}`);

  // ── launch app + sign up ─────────────────────────────────────────────────
  const launched = await launchHitch({ profile: "v2-delegate" });
  const { page, stateDir } = launched;
  cleanupApp = launched.cleanup;
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const taskRow = (title) => page.locator("[data-testid=v2-task-row]", { hasText: title });

  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("Delegate E2E");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator("[data-testid=v2-project-row]", { hasText: "Inbox" }).waitFor({ timeout: 30_000 });
  check("1. signed up into the V2 workspace (Inbox ready)");

  const creds = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8")).hitchServer;
  if (!creds?.apiKey) throw new Error("no api key stored after sign-up");

  const api = async (method, path, body) => {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  async function waitFor(label, fn, { timeoutMs = 25_000, everyMs = 200 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      last = await fn().catch(() => undefined);
      if (last) return last;
      await sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
  }
  const assignmentsFor = async (taskId) =>
    (await api("GET", "/assignments")).filter((a) => a.taskId === taskId);
  const latestAssignment = async (taskId) => {
    const rows = await assignmentsFor(taskId);
    return rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
  };

  // ── spawn the fake daemon (owns the reconcile loop) ──────────────────────
  scratch = mkdtempSync(join(tmpdir(), "hitch-delegate-"));
  daemon = spawn("npx", ["tsx", "daemon/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HITCH_SERVER_URL: SERVER_URL,
      HITCH_API_KEY: creds.apiKey,
      HITCH_FAKE_LAUNCH: "1",
      // A long turn delay keeps `running` (WORKING) observable in the list
      // before it folds to `waiting_input` (NEEDS YOU).
      HITCH_FAKE_LAUNCH_DELAY_MS: "4000",
      HITCH_APP_SUPPORT_DIR: scratch,
      HITCH_RECONCILE_MS: "600",
      HITCH_HEARTBEAT_MS: "4000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (d) => {
    daemonOut += d;
    appendFileSync(LOG, `[daemon] ${d}`);
  });
  daemon.stderr.on("data", (d) => {
    daemonOut += d;
    appendFileSync(LOG, `[daemon:err] ${d}`);
  });

  const machine = await waitFor("machine registration", async () => {
    const rows = await api("GET", "/machines");
    return rows[0];
  });
  check("2. fake daemon registered its machine", Boolean(machine?.id), machine?.name);
  // Give the app's WS a beat to refetch ["machines"] so the bar sees it online.
  await sleep(1500);

  // ── stage A: delegate in the UI ──────────────────────────────────────────
  const task = await api("POST", "/tasks", {
    projectId: (await api("GET", "/projects")).find((p) => p.name === "Inbox").id,
    title: "Delegate me",
    body: "Do the delegated thing.",
    sortOrder: "a0",
  });
  await taskRow("Delegate me").waitFor({ timeout: 10_000 });
  await taskRow("Delegate me").click();
  const delegateBtn = page.getByRole("button", { name: "Delegate" });
  await delegateBtn.waitFor({ timeout: 10_000 });
  await waitFor("delegate button enabled (machine online)", async () =>
    (await delegateBtn.isEnabled()) ? true : undefined,
  );
  await shot("v2-delegate-01-compose");
  await delegateBtn.click();

  const assignment = await waitFor("assignment row created", async () =>
    (await assignmentsFor(task.id))[0],
  );
  check("3. delegating in the UI created an assignment row", Boolean(assignment?.id),
    `harness=${assignment?.harness}, desired=${assignment?.desiredState}`);

  // ── stage B: chip walks Spawning… → Working → Needs you ───────────────────
  const chip = page.locator("[data-testid=v2-delegate-chip]");
  await chip.filter({ hasText: "Working" }).waitFor({ timeout: 15_000 });
  check("4. delegate chip reached Working (observed=running)");
  await shot("v2-delegate-02-working-chip");
  // Close the dialog and see the WORKING group reflect it.
  await page.keyboard.press("Escape");
  await page.locator("[data-testid=v2-working] [data-testid=v2-task-row]", { hasText: "Delegate me" })
    .waitFor({ timeout: 15_000 });
  check("5. task appears in the WORKING group");
  await shot("v2-delegate-03-working-group");

  // The fake turn completes → waiting_input → NEEDS YOU.
  await page.locator("[data-testid=v2-needs-you] [data-testid=v2-task-row]", { hasText: "Delegate me" })
    .waitFor({ timeout: 20_000 });
  check("6. task moves to the NEEDS YOU group (observed=waiting_input)");
  await shot("v2-delegate-04-needs-you");

  // ── stage C: Open chat relays a focus event the daemon logs ──────────────
  const linked = await waitFor("assignment linked a chat", async () => {
    const a = await latestAssignment(task.id);
    return a?.chatId ? a : undefined;
  });
  await taskRow("Delegate me").click();
  const openChat = page.getByRole("button", { name: "Open chat" });
  await openChat.waitFor({ timeout: 10_000 });
  await waitFor("open-chat enabled", async () => ((await openChat.isEnabled()) ? true : undefined));
  await openChat.click();
  await waitFor(
    "daemon logs the focus event",
    async () =>
      daemonOut.includes(`focus event received for chat ${linked.chatId}`) ? true : undefined,
    { timeoutMs: 15_000 },
  );
  check("7. Open chat → daemon logged the focus event with the right chatId", true,
    `chatId=${linked.chatId}`);

  // ── stage D: ack a done assignment ───────────────────────────────────────
  await page.getByRole("button", { name: "Stop" }).click();
  await waitFor("observed=done after Stop", async () => {
    const a = await latestAssignment(task.id);
    return a?.observedState === "done" ? a : undefined;
  });
  check("8. Stop → desired=stopped → observed=done (re-delegate state)");
  await page.keyboard.press("Escape");
  // Task is still OPEN with a done∧unreviewed assignment → NEEDS YOU (review).
  const reviewRow = page.locator(
    "[data-testid=v2-needs-you] [data-testid=v2-task-row]",
    { hasText: "Delegate me" },
  );
  await reviewRow.waitFor({ timeout: 15_000 });
  const markReviewed = reviewRow.getByRole("button", { name: "Mark reviewed" });
  await markReviewed.waitFor({ timeout: 10_000 });
  check("9. done∧unreviewed shows in NEEDS YOU with an ack affordance");
  await shot("v2-delegate-05-ack-affordance");
  await markReviewed.click();
  await waitFor("reviewed_at stamped", async () => {
    const a = await latestAssignment(task.id);
    return a?.reviewedAt ? a : undefined;
  });
  check("10. ack stamped reviewed_at (assignment left the attention queue)");
  // The row falls back to BACKLOG (open, no attention).
  await page.locator("[data-testid=v2-backlog] [data-testid=v2-task-row]", { hasText: "Delegate me" })
    .waitFor({ timeout: 10_000 });
  check("11. acked task returned to BACKLOG");
  await shot("v2-delegate-06-acked");

  // ── stage E: close-on-done ───────────────────────────────────────────────
  await taskRow("Delegate me").click();
  const delegateAgain = page.getByRole("button", { name: "Delegate" });
  await delegateAgain.waitFor({ timeout: 10_000 });
  await waitFor("re-delegate enabled", async () => ((await delegateAgain.isEnabled()) ? true : undefined));
  await delegateAgain.click();
  const running = await waitFor("new assignment running", async () => {
    const a = await latestAssignment(task.id);
    return a && ["running", "spawning"].includes(a.observedState) ? a : undefined;
  });
  await page.keyboard.press("Escape");
  await page.locator("[data-testid=v2-working] [data-testid=v2-task-row]", { hasText: "Delegate me" })
    .waitFor({ timeout: 15_000 });
  check("12. re-delegated; task back in WORKING");

  // Mark the task done via the list checkbox → close-on-done.
  await page
    .locator("[data-testid=v2-working] [data-testid=v2-task-row]", { hasText: "Delegate me" })
    .locator('[role=checkbox]')
    .click();
  await waitFor("close-on-done flipped desired=stopped", async () => {
    const a = (await assignmentsFor(task.id)).find((x) => x.id === running.id);
    return a?.desiredState === "stopped" ? a : undefined;
  });
  check("13. checking done flipped the live assignment's desired_state=stopped");
  await waitFor("closed assignment observed=done", async () => {
    const a = (await assignmentsFor(task.id)).find((x) => x.id === running.id);
    return a?.observedState === "done" ? a : undefined;
  });
  check("14. reconciler closed the chat (observed=done)");
  await page.locator("[data-testid=v2-done] [data-testid=v2-task-row]", { hasText: "Delegate me" })
    .waitFor({ timeout: 10_000 });
  check("15. done task sits in DONE (out of the attention queue)");
  await shot("v2-delegate-07-close-on-done");
} catch (error) {
  check("run completed without throwing", false, String(error));
} finally {
  await cleanupApp().catch(() => {});
  if (daemon) daemon.kill("SIGINT");
  await sleep(500);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (process.env.SKIP_COMPOSE !== "1" && process.env.KEEP_COMPOSE !== "1") {
    log("→ docker compose down -v");
    try {
      compose(["down", "-v"]);
    } catch (e) {
      log(`compose down failed: ${String(e)}`);
    }
  }
}

const failed = results.filter((r) => !r.pass).length;
log(`\nlog: ${LOG}`);
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
