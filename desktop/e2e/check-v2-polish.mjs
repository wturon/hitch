// One-off check for V2 M2 PR 7: ⌘K palette, server-unreachable banner, empty
// states. DISPOSABLE, not a maintained test — see ../../AGENTS.md.
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010) and
// the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-polish.mjs
//
// NOTE: the banner section stops/starts the compose `server` container via the
// docker CLI, so this script must run on the machine that owns the stack.
//
// Drives: sign-up → empty-Inbox hint → seed a Work project (+ a tag on a task,
// + an ORPHAN tag no task carries) over the API → no-match filter empty state
// → ⌘K palette (fuzzy-find a seeded task and Enter-open its dialog; switch
// projects by name; "New task" opens the capture card) → stop the server
// container mid-run (banner appears) → start it (banner clears, WS liveness
// proves data flows again).

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SERVER_URL = process.env.HITCH_SERVER_URL;
if (!SERVER_URL) {
  console.error("Set HITCH_SERVER_URL (e.g. http://localhost:3010) first.");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compose = (...args) =>
  execFileSync("docker", ["compose", ...args], { cwd: repoRoot, stdio: "inherit" });

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-polish.log");
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

const email = `e2e-polish-${Date.now()}@example.com`;
const password = "hitch-e2e-password";

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-polish" });
// If the banner section threw mid-outage, the server container may still be
// stopped — restart it no matter what so later scripts see a live stack.
let serverStopped = false;
try {
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const projectRow = (name) =>
    page.locator("[data-testid=v2-project-row]", { hasText: name });
  const taskRow = (name) =>
    page.locator("[data-testid=v2-task-row]", { hasText: name });
  const dialog = () => page.locator('[data-slot="task-dialog-v2"]');
  const banner = () => page.locator("[data-testid=v2-connection-banner]");
  const palette = () => page.locator('input[placeholder^="Search tasks"]');
  const header = () => page.locator("header h1");

  // 1. Sign-up → workspace with an auto-created, selected Inbox.
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("E2E Polish");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await projectRow("Inbox").waitFor({ timeout: 30_000 });
  check("1. sign-up lands in the workspace");

  // 2. Empty-project hint (V1's illustration, "Add your first todo").
  await page.getByText("Add your first todo").waitFor({ timeout: 10_000 });
  check("2. empty Inbox shows the empty hint");
  await shot("v2-polish-01-empty-inbox");

  // 3. Seed over the API: Work project, three open tasks, one tagged, plus an
  // orphan tag NO task carries (for the no-match filter state).
  const secrets = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  const creds = secrets.hitchServer;
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
  await api("POST", "/tags", { name: "orphan", color: "blue" });
  const alpha = await api("POST", "/tasks", { projectId: work.id, title: "Alpha task", sortOrder: "a0" });
  await api("POST", "/tasks", { projectId: work.id, title: "Beta task", sortOrder: "a1" });
  await api("POST", "/tasks", { projectId: work.id, title: "Gamma task", sortOrder: "a2" });
  await api("POST", `/tasks/${alpha.id}/tags/${urgent.id}`);
  check("3. seeded Work project + tags + 3 tasks via the API");

  // 4. No-match filter empty state: filter Work by the orphan tag.
  await projectRow("Work").waitFor({ timeout: 10_000 });
  await projectRow("Work").click();
  await taskRow("Alpha task").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByPlaceholder("Filter by tag…").waitFor({ timeout: 5_000 });
  await page
    .locator('[role="option"]')
    .filter({ hasText: /^orphan/ })
    .click();
  await page.keyboard.press("Escape"); // close the filter popover
  await page.getByText("No todos match this filter.").waitFor({ timeout: 5_000 });
  check("4. no-match filter shows its empty state");
  const rowsUnderFilter = await page.locator("[data-testid=v2-task-row]").count();
  check("5. the filtered list is actually empty", rowsUnderFilter === 0);
  await shot("v2-polish-02-filter-no-match");
  await page.getByRole("button", { name: "Clear" }).click();
  await taskRow("Alpha task").waitFor({ timeout: 5_000 });
  check("6. clearing the filter restores the list");

  // 5. ⌘K: fuzzy-find a seeded task, Enter opens its dialog.
  await page.keyboard.press("Meta+k");
  await palette().waitFor({ timeout: 5_000 });
  check("7. ⌘K opens the command palette");
  await palette().fill("gam");
  await page
    .locator('[role="option"]')
    .filter({ hasText: "Gamma task" })
    .waitFor({ timeout: 5_000 });
  await shot("v2-polish-03-palette-task");
  await page.keyboard.press("Enter");
  await dialog().waitFor({ timeout: 10_000 });
  const openedTitle = await page.locator('[aria-label="Task title"]').inputValue();
  check("8. Enter opens the matched task's dialog", openedTitle === "Gamma task", `title=${openedTitle}`);
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 5_000 });

  // 6. ⌘K switches projects by name (both directions).
  await page.keyboard.press("Meta+k");
  await palette().waitFor({ timeout: 5_000 });
  await palette().fill("inbox");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("header h1")?.textContent?.trim() === "Inbox",
    undefined,
    { timeout: 5_000 },
  );
  check("9. palette switches to Inbox");
  await page.keyboard.press("Meta+k");
  await palette().waitFor({ timeout: 5_000 });
  await palette().fill("work");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("header h1")?.textContent?.trim() === "Work",
    undefined,
    { timeout: 5_000 },
  );
  check("10. palette switches back to Work");

  // 7. ⌘K "New task" opens the capture card (body-only — the query isn't
  // seeded, V1 Decision 10).
  await page.keyboard.press("Meta+k");
  await palette().waitFor({ timeout: 5_000 });
  await page
    .locator('[role="option"]')
    .filter({ hasText: "New task" })
    .click();
  await dialog().waitFor({ timeout: 10_000 });
  check("11. palette's New task opens the capture card");
  await shot("v2-polish-04-palette-capture");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 5_000 });

  // 8. Unreachable banner: stop the server container → the WS drops and the
  // banner pill appears; no dialogs, no toasts.
  serverStopped = true;
  compose("stop", "server");
  await banner().waitFor({ timeout: 30_000 });
  check("12. stopping the server surfaces the unreachable banner");
  await shot("v2-polish-05-banner");

  // 9. Recovery: start the container → WS reconnects (capped backoff, ≤30s) →
  // banner clears; an out-of-band create then proves live data flows again.
  compose("start", "server");
  serverStopped = false;
  await banner().waitFor({ state: "detached", timeout: 90_000 });
  check("13. banner auto-dismisses once the server is back");
  await api("POST", "/tasks", { projectId: work.id, title: "After outage", sortOrder: "a3" });
  await taskRow("After outage").waitFor({ timeout: 15_000 });
  check("14. data flows again after recovery (WS + refetch)");
  await shot("v2-polish-06-recovered");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-polish-99-error.png") }).catch(() => {});
} finally {
  if (serverStopped) {
    try {
      compose("start", "server");
    } catch {
      /* stack may already be gone */
    }
  }
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
