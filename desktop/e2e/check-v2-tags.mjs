// One-off check for V2 M2 PR 5: tags on the server — create via the row's
// Tags ▸ submenu (rotation color), assign/unassign (optimistic pills + server
// task_tags truth), the AND-semantics multi-tag filter bar with facet counts
// and per-project localStorage persistence, and the dialog's tag lane.
// DISPOSABLE, not a maintained test — see ../../AGENTS.md.
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010) and
// the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-tags.mjs
//
// Drives: sign-up → seed a Work project over the API → create "bug" from the
// context-menu submenu (pill + server tag row with the first rotation color +
// task_tags link) → assign/unassign/re-assign on another row → create
// "urgent" → filter popover facet counts → single-tag filter (add-row hides)
// → AND narrowing → reload persistence → chip removal → exclusive Untagged →
// Clear → dialog tag lane (assign, create, unassign; server truth) → row
// pills agree after close.

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
const LOG = join(SHOTS, "v2-tags.log");
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

const email = `e2e-${Date.now()}@example.com`;
const password = "hitch-e2e-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-tags" });

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 300s, exiting");
  cleanup().finally(() => process.exit(2));
}, 300_000);

try {
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const projectRow = (name) =>
    page.locator("[data-testid=v2-project-row]", { hasText: name });
  const taskRow = (name) =>
    page.locator("[data-testid=v2-task-row]", { hasText: name });
  const rowTitles = async () =>
    (
      await page.locator("[data-testid=v2-task-row]").allInnerTexts()
    ).map((t) => t.split("\n")[0]);
  const rowPill = (rowName, tagName) =>
    taskRow(rowName).getByText(tagName, { exact: true });
  // A cmdk option whose text STARTS with `text` — filter-mode rows concatenate
  // the trailing facet count into textContent ("bug" + "2" → "bug2"), and the
  // "Create bug" row starts with "Create", so a name anchor never collides.
  const option = (text) =>
    page.locator('[role="option"]').filter({ hasText: new RegExp(`^${text}`) });
  // The facet count is the option's only digits.
  const optionCount = async (name) =>
    (await option(name).textContent()).replace(/\D+/g, "");
  // Escape until every menu layer is gone (the Tags ▸ submenu closes a layer
  // at a time; the exit animation also keeps a data-closed layer in the DOM
  // for a beat).
  const closeMenus = async () => {
    for (let i = 0; i < 10; i++) {
      if ((await page.getByRole("menu").count()) === 0) return;
      await page.keyboard.press("Escape");
      await sleep(250);
    }
    throw new Error("context menu never closed");
  };
  // Open a row's Tags ▸ submenu and hand back the combobox input. The Base UI
  // submenu opens on hover (a click toggles it straight closed again), so
  // hover and give the open a beat, retrying once if the first hover landed
  // mid-animation.
  const openTagsSubmenu = async (rowName) => {
    await taskRow(rowName).click({ button: "right" });
    const input = page.getByPlaceholder("Search or create tag…");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("menuitem", { name: "Tags" }).hover();
      try {
        await input.waitFor({ timeout: 2_000 });
        return input;
      } catch {
        /* hover again */
      }
    }
    throw new Error("Tags submenu never opened");
  };

  // --- Sign up, land in the workspace --------------------------------------
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("E2E User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await projectRow("Inbox").waitFor({ timeout: 30_000 });
  check("1. sign-up lands in the workspace");

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

  // --- Seed: Work project, 3 backlog rows ----------------------------------
  const work = await api("POST", "/projects", { name: "Work", sortOrder: "m" });
  const alpha = await api("POST", "/tasks", { projectId: work.id, title: "Alpha task", sortOrder: "a0" });
  const beta = await api("POST", "/tasks", { projectId: work.id, title: "Beta task", sortOrder: "a1" });
  const gamma = await api("POST", "/tasks", { projectId: work.id, title: "Gamma task", sortOrder: "a2" });
  await projectRow("Work").waitFor({ timeout: 10_000 });
  await projectRow("Work").click();
  await taskRow("Alpha task").waitFor({ timeout: 10_000 });
  check("2. seeded Work project renders (3 backlog rows, no tags yet)");
  // No tags anywhere → no filter bar chrome (V1's hasAnyTags gate).
  check(
    "3. filter bar hidden while no tags exist",
    (await page.getByRole("button", { name: "Filter", exact: true }).count()) === 0,
  );

  // --- CREATE via the context-menu Tags ▸ submenu --------------------------
  const createInput = await openTagsSubmenu("Alpha task");
  check("4. Tags ▸ submenu opens the assign combobox");
  await createInput.fill("bug");
  await option("Create").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Enter");
  await rowPill("Alpha task", "bug").waitFor({ timeout: 5_000 });
  check("5. Create assigns the new tag — pill on the row (optimistic)");
  await shot("v2-tags-01-created");
  await closeMenus();
  await sleep(600);
  const tagsAfterCreate = await api("GET", "/tags");
  const bugTag = tagsAfterCreate.find((t) => t.name === "bug");
  check(
    "6. server: tag row exists with the FIRST rotation color (blue)",
    bugTag !== undefined && bugTag.color === "blue",
    `tags=${JSON.stringify(tagsAfterCreate.map((t) => [t.name, t.color]))}`,
  );
  const alphaLinked = await api("GET", `/tasks/${alpha.id}`);
  check(
    "7. server: task_tags link reflected in the task's tagIds",
    bugTag !== undefined && JSON.stringify(alphaLinked.tagIds) === JSON.stringify([bugTag.id]),
    `tagIds=${JSON.stringify(alphaLinked.tagIds)}`,
  );

  // --- ASSIGN an existing tag, UNASSIGN it, re-assign ----------------------
  await openTagsSubmenu("Beta task");
  await option("bug").click();
  await rowPill("Beta task", "bug").waitFor({ timeout: 5_000 });
  check("8. toggling an existing tag on assigns it (pill appears)");
  await sleep(600);
  check(
    "9. server: Beta's tagIds now carry the tag",
    JSON.stringify((await api("GET", `/tasks/${beta.id}`)).tagIds) ===
      JSON.stringify([bugTag.id]),
  );
  // The combobox stays open (multi-toggle in one visit) — toggle it back off.
  await option("bug").click();
  await rowPill("Beta task", "bug").waitFor({ state: "detached", timeout: 5_000 });
  check("10. toggling again unassigns (pill gone, surface stayed open)");
  await sleep(600);
  check(
    "11. server: the link row is deleted",
    (await api("GET", `/tasks/${beta.id}`)).tagIds.length === 0,
  );
  await option("bug").click(); // back on — Beta keeps bug for the AND checks
  await closeMenus();

  // Second tag on Alpha: urgent (second rotation color).
  const urgentInput = await openTagsSubmenu("Alpha task");
  await urgentInput.fill("urgent");
  await option("Create").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Enter");
  await rowPill("Alpha task", "urgent").waitFor({ timeout: 5_000 });
  await closeMenus();
  await sleep(600);
  const urgentTag = (await api("GET", "/tags")).find((t) => t.name === "urgent");
  check(
    "12. second created tag takes the next rotation color (green)",
    urgentTag !== undefined && urgentTag.color === "green",
    `color=${urgentTag?.color}`,
  );

  // --- FILTER: facet counts, AND semantics, add-row hides ------------------
  // Tag census now: Alpha=bug+urgent, Beta=bug, Gamma=untagged.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByPlaceholder("Filter by tag…").waitFor({ timeout: 5_000 });
  const facetDetail = async () =>
    `bug=${await optionCount("bug")} urgent=${await optionCount("urgent")} untagged=${await optionCount("Untagged")}`;
  check(
    "13. facet counts: bug 2, urgent 1, Untagged 1",
    (await optionCount("bug")) === "2" &&
      (await optionCount("urgent")) === "1" &&
      (await optionCount("Untagged")) === "1",
    await facetDetail(),
  );
  await shot("v2-tags-02-filter-popover");
  await option("bug").click();
  await sleep(300);
  check(
    "14. single-tag filter narrows to the tagged rows",
    JSON.stringify(await rowTitles()) === JSON.stringify(["Alpha task", "Beta task"]),
    (await rowTitles()).join(" | "),
  );
  check(
    "15. the capture add-row hides while a filter is active (V1)",
    (await page.locator("[data-testid=v2-add-task]").count()) === 0,
  );
  check(
    "16. facet preview against the selection: urgent still counts 1 (AND probe)",
    (await optionCount("urgent")) === "1",
    await facetDetail(),
  );
  await option("urgent").click();
  await sleep(300);
  check(
    "17. adding a second tag ANDs: only the row with BOTH remains",
    JSON.stringify(await rowTitles()) === JSON.stringify(["Alpha task"]),
    (await rowTitles()).join(" | "),
  );
  await page.keyboard.press("Escape");
  await shot("v2-tags-03-and-filter");

  // --- Persistence: the filter survives a renderer reload ------------------
  await page.reload();
  await taskRow("Alpha task").waitFor({ timeout: 30_000 });
  await sleep(400);
  check(
    "18. filter persists across reload (chips + narrowed list)",
    JSON.stringify(await rowTitles()) === JSON.stringify(["Alpha task"]) &&
      (await page.getByRole("button", { name: "Remove bug filter" }).count()) === 1 &&
      (await page.getByRole("button", { name: "Remove urgent filter" }).count()) === 1,
    (await rowTitles()).join(" | "),
  );
  await page.getByRole("button", { name: "Remove urgent filter" }).click();
  await sleep(300);
  check(
    "19. removing one chip re-widens to the remaining AND set",
    JSON.stringify(await rowTitles()) === JSON.stringify(["Alpha task", "Beta task"]),
    (await rowTitles()).join(" | "),
  );

  // --- Untagged is exclusive; Clear restores everything --------------------
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByPlaceholder("Filter by tag…").waitFor({ timeout: 5_000 });
  await option("Untagged").click();
  await page.keyboard.press("Escape");
  await sleep(300);
  check(
    "20. Untagged clears tag selections (exclusive) and shows only untagged rows",
    JSON.stringify(await rowTitles()) === JSON.stringify(["Gamma task"]) &&
      (await page.getByRole("button", { name: "Remove bug filter" }).count()) === 0,
    (await rowTitles()).join(" | "),
  );
  await shot("v2-tags-04-untagged");
  await page.getByRole("button", { name: "Clear" }).click();
  await sleep(300);
  check(
    "21. Clear restores the full list + the add-row",
    JSON.stringify(await rowTitles()) ===
      JSON.stringify(["Alpha task", "Beta task", "Gamma task"]) &&
      (await page.locator("[data-testid=v2-add-task]").count()) === 1,
    (await rowTitles()).join(" | "),
  );

  // --- DIALOG tag lane: assign, create, unassign ---------------------------
  await taskRow("Gamma task").click();
  const dialog = page.locator('[data-slot="task-dialog-v2"]');
  await dialog.locator('input[aria-label="Task title"]').waitFor({ timeout: 5_000 });
  const editTags = dialog.getByRole("button", { name: "Edit tags" });
  check(
    "22. the dialog's tag lane shows the Add tag affordance on an untagged task",
    (await editTags.innerText()).includes("Add tag"),
  );
  await editTags.click();
  await page.getByPlaceholder("Search or create tag…").waitFor({ timeout: 5_000 });
  await option("urgent").click();
  await dialog.getByText("urgent", { exact: true }).waitFor({ timeout: 5_000 });
  check("23. lane combobox assigns an existing tag (pill in the lane)");
  await page.getByPlaceholder("Search or create tag…").fill("ui");
  await option("Create").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Enter");
  await dialog.getByText("ui", { exact: true }).waitFor({ timeout: 5_000 });
  await shot("v2-tags-05-dialog-lane");
  await sleep(600);
  const uiTag = (await api("GET", "/tags")).find((t) => t.name === "ui");
  const gammaTagged = await api("GET", `/tasks/${gamma.id}`);
  check(
    "24. server: lane writes landed (urgent + new ui tag, third rotation color orange)",
    uiTag !== undefined &&
      uiTag.color === "orange" &&
      JSON.stringify([...gammaTagged.tagIds].sort()) ===
        JSON.stringify([urgentTag.id, uiTag.id].sort()),
    `color=${uiTag?.color} tagIds=${JSON.stringify(gammaTagged.tagIds)}`,
  );
  await option("urgent").click(); // toggle back off from the same open surface
  await dialog
    .getByText("urgent", { exact: true })
    .waitFor({ state: "detached", timeout: 5_000 });
  await sleep(600);
  check(
    "25. lane unassign: pill gone + server link deleted",
    JSON.stringify((await api("GET", `/tasks/${gamma.id}`)).tagIds) ===
      JSON.stringify([uiTag.id]),
  );
  await closeMenus(); // close the combobox menu
  await page.keyboard.press("Escape"); // close the dialog
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  await rowPill("Gamma task", "ui").waitFor({ timeout: 5_000 });
  check("26. the row's pills agree with the dialog after close");
  await shot("v2-tags-06-final");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-tags-99-error.png") }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
