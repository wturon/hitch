// One-off check for V2 M2 PR 2: the TodosViewV2 read path + Inbox. Replaces
// check-v2-foundation.mjs (the proof-of-life UI it asserted is gone) and keeps
// its foundation coverage: sign-up, api-key persistence, WS invalidation,
// sign-out. DISPOSABLE, not a maintained test — see ../../AGENTS.md.
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010) and
// the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-todos-read.mjs
//
// Drives: V2 mode switch → sign-up → Inbox auto-created + selected → seed a
// second project with tasks (shuffled sortOrder), tags, and done rows OVER THE
// API → switch projects and assert ordering/grouping/pills → WS liveness (an
// out-of-band task create appears with no renderer action) → sign out.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SERVER_URL = process.env.HITCH_SERVER_URL;
if (!SERVER_URL) {
  console.error("Set HITCH_SERVER_URL (e.g. http://localhost:3010) first.");
  process.exit(1);
}

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-todos-read.log");
writeFileSync(LOG, "");

const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
// pass defaults to true: reaching a bare check() means its awaited waitFor
// above resolved (a timeout would have thrown into the catch).
const check = (name, pass = true, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const email = `e2e-${Date.now()}@example.com`;
const password = "hitch-e2e-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-todos-read" });
try {
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const projectRow = (name) =>
    page.locator("[data-testid=v2-project-row]", { hasText: name });
  const taskRow = (name) =>
    page.locator("[data-testid=v2-task-row]", { hasText: name });

  // 1. V2 mode switch: the sign-in screen (not the V1 Convex tree) mounts.
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  const v1Visible = await page
    .getByRole("button", { name: "Continue with GitHub" })
    .count();
  check("1. V2 sign-in screen mounts under HITCH_SERVER_URL", v1Visible === 0);

  // 2. Sign-up through the main-process auth flow.
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("E2E User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();

  // 3. Inbox is ensured on boot for the fresh account, pinned into the rail,
  // and selected by default (header + aria-current agree).
  await projectRow("Inbox").waitFor({ timeout: 30_000 });
  check("2. sign-up lands in the workspace with an auto-created Inbox");
  await page
    .locator('[data-testid=v2-project-row][aria-current="true"]', { hasText: "Inbox" })
    .waitFor({ timeout: 10_000 });
  const headerText = await page.locator("header h1").innerText();
  check("3. Inbox is the default selection", headerText.trim() === "Inbox", `header=${headerText}`);
  await page.getByText("Add your first todo").waitFor({ timeout: 10_000 });
  check("4. empty Inbox shows the empty hint");
  await shot("v2-todos-01-inbox-empty");

  // The main process persisted {serverUrl, apiKey} in the isolated secrets —
  // and it's what the seeding below authenticates with.
  const secrets = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  const creds = secrets.hitchServer;
  check(
    "5. api key stored in secrets.json under hitchServer",
    Boolean(creds?.apiKey && creds?.serverUrl === SERVER_URL),
    `serverUrl=${creds?.serverUrl}`,
  );

  // 4. Seed over the server API (out-of-band — nothing touches the renderer).
  const api = async (method, path, body) => {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  };

  const work = await api("POST", "/projects", { name: "Work", sortOrder: "m" });
  const urgent = await api("POST", "/tags", { name: "urgent", color: "red" });
  const design = await api("POST", "/tags", { name: "design", color: "blue" });
  // Created in shuffled order on purpose: render order must come from
  // sortOrder, not creation order.
  const gamma = await api("POST", "/tasks", { projectId: work.id, title: "Gamma task", sortOrder: "a2" });
  const alpha = await api("POST", "/tasks", { projectId: work.id, title: "Alpha task", sortOrder: "a0" });
  const beta = await api("POST", "/tasks", { projectId: work.id, title: "Beta task", sortOrder: "a1" });
  const doneOld = await api("POST", "/tasks", { projectId: work.id, title: "Old done task", sortOrder: "a3" });
  const doneNew = await api("POST", "/tasks", { projectId: work.id, title: "New done task", sortOrder: "a4" });
  await api("POST", `/tasks/${alpha.id}/tags/${urgent.id}`);
  await api("POST", `/tasks/${alpha.id}/tags/${design.id}`);
  await api("POST", `/tasks/${beta.id}/tags/${urgent.id}`);
  // completedAt is server-stamped; space the two so DONE has a strict order —
  // doneOld completes FIRST (older) even though its sortOrder is smaller.
  await api("PATCH", `/tasks/${doneOld.id}`, { status: "done" });
  await sleep(75);
  await api("PATCH", `/tasks/${doneNew.id}`, { status: "done" });
  check("6. seeded Work project + 2 tags + 5 tasks (2 done) via the API");

  // 5. The out-of-band project lands in the rail via WS invalidation.
  await projectRow("Work").waitFor({ timeout: 10_000 });
  check("7. out-of-band project appears in the sidebar (WS invalidation)");

  // 6. Switch to Work; open tasks render in sortOrder, done group below.
  await projectRow("Work").click();
  await taskRow("Alpha task").waitFor({ timeout: 10_000 });
  check("8. selecting a project switches the task list");
  const backlogTitles = await page
    .locator("[data-testid=v2-backlog] [data-testid=v2-task-row]")
    .allInnerTexts();
  check(
    "9. open tasks render in sortOrder (not creation order)",
    JSON.stringify(backlogTitles.map((t) => t.split("\n")[0])) ===
      JSON.stringify(["Alpha task", "Beta task", "Gamma task"]),
    backlogTitles.join(" | "),
  );
  const doneTitles = await page
    .locator("[data-testid=v2-done] [data-testid=v2-task-row]")
    .allInnerTexts();
  check(
    "10. done group ordered by completedAt desc",
    JSON.stringify(doneTitles.map((t) => t.split("\n")[0])) ===
      JSON.stringify(["New done task", "Old done task"]),
    doneTitles.join(" | "),
  );
  const doneChecked = await page
    .locator('[data-testid=v2-done] [role=checkbox][aria-checked="true"]')
    .count();
  check("11. done rows carry a checked (visual-only) checkbox", doneChecked === 2);

  // 7. Tag pills resolved from tagIds against GET /tags.
  const alphaText = await taskRow("Alpha task").innerText();
  check(
    "12. tag pills render on tagged rows",
    alphaText.includes("urgent") && alphaText.includes("design"),
    alphaText.replace(/\n/g, " | "),
  );
  const betaText = await taskRow("Beta task").innerText();
  check(
    "13. pills match each row's own tags",
    betaText.includes("urgent") && !betaText.includes("design"),
    betaText.replace(/\n/g, " | "),
  );
  await shot("v2-todos-02-work-groups");

  // 8. WS liveness on tasks: an out-of-band create appears with NO UI action.
  await api("POST", "/tasks", { projectId: work.id, title: "Via Websocket", sortOrder: "a1V" });
  await taskRow("Via Websocket").waitFor({ timeout: 10_000 });
  const afterLive = await page
    .locator("[data-testid=v2-backlog] [data-testid=v2-task-row]")
    .allInnerTexts();
  check(
    "14. out-of-band task appears mid-list via WS invalidation",
    JSON.stringify(afterLive.map((t) => t.split("\n")[0])) ===
      JSON.stringify(["Alpha task", "Beta task", "Via Websocket", "Gamma task"]),
    afterLive.join(" | "),
  );
  await shot("v2-todos-03-ws-task");

  // 9. Switching back to Inbox shows its (empty) list, not Work's.
  await projectRow("Inbox").click();
  await page.getByText("Add your first todo").waitFor({ timeout: 10_000 });
  const inboxRows = await page.locator("[data-testid=v2-task-row]").count();
  check("15. switching projects switches lists (Inbox is empty)", inboxRows === 0);
  await shot("v2-todos-04-back-to-inbox");

  // 10. Sign out via the account footer menu: back to sign-in, creds cleared,
  // key revoked server-side.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 10_000 });
  check("16. sign-out returns to the sign-in screen");
  const after = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  check("17. hitchServer creds cleared from secrets.json", !after.hitchServer);
  const revoked = await fetch(`${SERVER_URL}/projects`, {
    headers: { "x-api-key": creds.apiKey },
  });
  check("18. api key revoked server-side", revoked.status === 401, `status=${revoked.status}`);
  await shot("v2-todos-05-signed-out");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-todos-99-error.png") }).catch(() => {});
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
