// One-off check for V2 M2 PR 4: the list mutations — check/uncheck (uncheck →
// top of backlog), drag reorder (single-task sortOrder PATCH), delete with
// undo (pending-delete window: the DELETE fires only when the toast times
// out), keyboard nav + context menu + dialog ⋯ menu. DISPOSABLE, not a
// maintained test — see ../../AGENTS.md.
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010) and
// the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-list-mutations.mjs
//
// Drives: sign-up → seed a Work project over the API → check a row (toast,
// DONE ordering, server completedAt) → uncheck (top of backlog, server
// sortOrder) → drag reorder (persists + survives reload) → keyboard nav
// (↑↓/↵, dialog ⋯ menu, dialog-delete closes the dialog) → keyboard delete on
// the hovered row + Undo (server NEVER deleted) → context-menu delete → toast
// times out → gone from the server → `e`/⌘Z toggle → guards.

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
const LOG = join(SHOTS, "v2-list-mutations.log");
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

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-list-mutations" });

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
  const backlogTitles = async () =>
    (
      await page
        .locator("[data-testid=v2-backlog] [data-testid=v2-task-row]")
        .allInnerTexts()
    ).map((t) => t.split("\n")[0]);
  const doneTitles = async () =>
    (
      await page
        .locator("[data-testid=v2-done] [data-testid=v2-task-row]")
        .allInnerTexts()
    ).map((t) => t.split("\n")[0]);
  const checkboxOf = (name) => taskRow(name).getByRole("checkbox");
  // Highlight the row via hover (hover arms the selection — the accepted V1
  // quirk), park the pointer so hover can't re-highlight, then press `key`.
  const highlightAndPress = async (locator, key) => {
    await locator.hover();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(200);
    await page.keyboard.press(key);
  };
  // Wait for every undo toast to leave the screen, so a later Undo click
  // can't grab a stale toast's action.
  const awaitToastsGone = async () => {
    for (let i = 0; i < 80; i++) {
      if ((await page.getByRole("button", { name: "Undo" }).count()) === 0) return;
      await sleep(250);
    }
    throw new Error("undo toasts never cleared");
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
  const serverTask = async (id) => {
    const response = await fetch(`${SERVER_URL}/tasks/${id}`, {
      headers: { "x-api-key": creds.apiKey },
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  };

  // --- Seed: Work project, 3 backlog rows + 1 pre-completed ----------------
  const work = await api("POST", "/projects", { name: "Work", sortOrder: "m" });
  const alpha = await api("POST", "/tasks", { projectId: work.id, title: "Alpha task", sortOrder: "a0" });
  const beta = await api("POST", "/tasks", { projectId: work.id, title: "Beta task", sortOrder: "a1" });
  const gamma = await api("POST", "/tasks", { projectId: work.id, title: "Gamma task", sortOrder: "a2" });
  const doneOld = await api("POST", "/tasks", { projectId: work.id, title: "Old done task", sortOrder: "a3" });
  await api("PATCH", `/tasks/${doneOld.id}`, { status: "done" });
  await projectRow("Work").waitFor({ timeout: 10_000 });
  await projectRow("Work").click();
  await taskRow("Alpha task").waitFor({ timeout: 10_000 });
  check("2. seeded Work project renders (3 backlog + 1 done)");

  // --- CHECK: checkbox → done, toast, DONE ordered by completedAt ----------
  await checkboxOf("Beta task").click();
  await page.getByText("Task marked done", { exact: false }).waitFor({ timeout: 5_000 });
  check("3. checking shows the 'Task marked done' undo toast");
  // Optimistic: the row is ALREADY in DONE, above the older completion.
  check(
    "4. checked row moves to DONE, newest completion first",
    JSON.stringify(await doneTitles()) ===
      JSON.stringify(["Beta task", "Old done task"]),
    (await doneTitles()).join(" | "),
  );
  await shot("v2-mut-01-checked");
  await sleep(600); // let the PATCH settle before reading server truth
  const betaDone = await serverTask(beta.id);
  check(
    "5. server: status done + completedAt stamped (server-side)",
    betaDone.body?.status === "done" && Boolean(betaDone.body?.completedAt),
    `status=${betaDone.body?.status} completedAt=${betaDone.body?.completedAt}`,
  );

  // --- UNCHECK: returns to the TOP of the backlog --------------------------
  await checkboxOf("Beta task").click();
  await sleep(600);
  check(
    "6. unchecked row returns to the TOP of the backlog",
    JSON.stringify(await backlogTitles()) ===
      JSON.stringify(["Beta task", "Alpha task", "Gamma task"]),
    (await backlogTitles()).join(" | "),
  );
  const betaOpen = await serverTask(beta.id);
  check(
    "7. server: status open, completedAt cleared, sortOrder before the old head",
    betaOpen.body?.status === "open" &&
      betaOpen.body?.completedAt === null &&
      betaOpen.body?.sortOrder < "a0",
    `sortOrder=${betaOpen.body?.sortOrder}`,
  );
  await shot("v2-mut-02-unchecked-top");

  // --- DRAG REORDER: Beta (head) dropped below Gamma (tail) ----------------
  const src = await taskRow("Beta task").boundingBox();
  const dst = await taskRow("Gamma task").boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  // Clear the 4px activation distance, then glide to below the target's
  // center so dnd-kit reads the drop as "after Gamma".
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 + 12, { steps: 3 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 4, { steps: 10 });
  await page.mouse.up();
  await sleep(600);
  check(
    "8. drag drops the row at its target slot (optimistic)",
    JSON.stringify(await backlogTitles()) ===
      JSON.stringify(["Alpha task", "Gamma task", "Beta task"]),
    (await backlogTitles()).join(" | "),
  );
  const betaMoved = await serverTask(beta.id);
  check(
    "9. server: single-task sortOrder PATCH landed (now after Gamma's a2)",
    betaMoved.body?.sortOrder > "a2" && betaMoved.body?.sortOrder !== betaOpen.body?.sortOrder,
    `sortOrder=${betaMoved.body?.sortOrder}`,
  );
  await shot("v2-mut-03-reordered");

  // --- Reload: the order is server truth, not render state -----------------
  await page.reload();
  await taskRow("Alpha task").waitFor({ timeout: 30_000 });
  check(
    "10. reorder survives a renderer reload",
    JSON.stringify(await backlogTitles()) ===
      JSON.stringify(["Alpha task", "Gamma task", "Beta task"]),
    (await backlogTitles()).join(" | "),
  );

  // --- KEYBOARD NAV: hover arms, arrows move, ↵ opens the dialog -----------
  await taskRow("Alpha task").hover();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowDown");
  const onGamma = await taskRow("Gamma task").getAttribute("aria-current");
  check("11. ↓ moves the highlight to the next row", onGamma === "true", `aria-current=${onGamma}`);
  await page.keyboard.press("ArrowUp");
  const onAlpha = await taskRow("Alpha task").getAttribute("aria-current");
  check("12. ↑ moves it back", onAlpha === "true", `aria-current=${onAlpha}`);
  await page.keyboard.press("Enter");
  const dialogTitle = page.locator('input[aria-label="Task title"]');
  await dialogTitle.waitFor({ timeout: 5_000 });
  check(
    "13. ↵ opens the highlighted task in the dialog",
    (await dialogTitle.inputValue()) === "Alpha task",
    `title=${await dialogTitle.inputValue()}`,
  );

  // --- Dialog ⋯ menu: Mark done + Delete; delete closes the dialog ---------
  await page.getByRole("button", { name: "Task actions" }).click();
  await page.getByRole("menu").waitFor({ timeout: 5_000 });
  const dialogMenuOk =
    (await page.getByRole("menuitem", { name: "Mark done", exact: true }).count()) === 1 &&
    (await page.getByRole("menuitem", { name: "Delete", exact: true }).count()) === 1;
  check("14. dialog ⋯ menu offers Mark done + Delete", dialogMenuOk);
  await shot("v2-mut-04-dialog-menu");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await dialogTitle.waitFor({ state: "detached", timeout: 5_000 });
  check("15. dialog delete closes the dialog (close-on-vanish)");
  await page.getByText("Task deleted", { exact: false }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Undo" }).first().click();
  await taskRow("Alpha task").waitFor({ timeout: 5_000 });
  check("16. Undo restores the dialog-deleted row to the list");
  await awaitToastsGone();

  // --- KEYBOARD DELETE on the hovered row + Undo (server never deleted) ----
  await highlightAndPress(taskRow("Gamma task"), "Backspace");
  await page.getByText("Task deleted", { exact: false }).waitFor({ timeout: 5_000 });
  check(
    "17. Backspace deletes the hovered/highlighted row (hover arms it)",
    (await taskRow("Gamma task").count()) === 0,
  );
  const gammaPending = await serverTask(gamma.id);
  check(
    "18. server STILL has the row during the undo window (delete deferred)",
    gammaPending.status === 200,
    `status=${gammaPending.status}`,
  );
  await shot("v2-mut-05-kb-deleted");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await taskRow("Gamma task").waitFor({ timeout: 5_000 });
  check(
    "19. Undo brings the row back, order intact (nothing was ever deleted)",
    JSON.stringify(await backlogTitles()) ===
      JSON.stringify(["Alpha task", "Gamma task", "Beta task"]),
    (await backlogTitles()).join(" | "),
  );
  const gammaBack = await serverTask(gamma.id);
  check("20. server row untouched after undo", gammaBack.status === 200);
  await shot("v2-mut-06-kb-undo");
  await awaitToastsGone();

  // --- CONTEXT MENU: structure, then Delete → toast timeout → committed ----
  await taskRow("Beta task").click({ button: "right" });
  await page.getByRole("menu").waitFor({ timeout: 5_000 });
  for (const label of ["Open", "Mark done", "Delete"]) {
    const count = await page.getByRole("menuitem", { name: label, exact: true }).count();
    check(`21. context menu offers "${label}"`, count === 1, `count=${count}`);
  }
  // V1-only entries must NOT be here (archive/chats are M4-or-never in V2).
  const v1Only = await page
    .getByRole("menuitem", { name: /Archive|Copy task path|Detach chat/ })
    .count();
  check("22. no V1-only entries (Archive / Copy task path / Detach chat)", v1Only === 0);
  await shot("v2-mut-07-context-menu");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByText("Task deleted", { exact: false }).waitFor({ timeout: 5_000 });
  check("23. context-menu delete hides the row + shows the toast",
    (await taskRow("Beta task").count()) === 0);
  // Let the undo window elapse (toast 6s + commit grace 0.5s).
  await sleep(7_200);
  const betaGone = await serverTask(beta.id);
  check(
    "24. after the toast times out the DELETE commits server-side (404)",
    betaGone.status === 404,
    `status=${betaGone.status}`,
  );
  check("25. row stays gone after the commit", (await taskRow("Beta task").count()) === 0);
  await shot("v2-mut-08-delete-committed");

  // --- `e` toggles done on the highlighted row; ⌘Z undoes ------------------
  await highlightAndPress(taskRow("Gamma task"), "e");
  await page.getByText("Task marked done", { exact: false }).waitFor({ timeout: 5_000 });
  check(
    "26. `e` marks the highlighted row done",
    (await doneTitles()).includes("Gamma task"),
    (await doneTitles()).join(" | "),
  );
  await page.keyboard.press("Meta+z");
  await sleep(600);
  check(
    "27. ⌘Z undoes the check — row back at the TOP of the backlog",
    JSON.stringify(await backlogTitles()) ===
      JSON.stringify(["Gamma task", "Alpha task"]),
    (await backlogTitles()).join(" | "),
  );
  await shot("v2-mut-09-e-undo");

  // --- Guards: add-row is delete-inert; capture typing never deletes -------
  const addRow = page.locator("[data-testid=v2-add-task]");
  await highlightAndPress(addRow, "Backspace");
  await page.waitForTimeout(300);
  check("28. Backspace on the add-row is a no-op", (await addRow.count()) === 1);
  await addRow.click();
  const captureBody = page.locator('[aria-label="Editor"][contenteditable="true"]');
  await captureBody.waitFor({ timeout: 10_000 });
  await captureBody.click();
  await page.keyboard.type("xy");
  const toastsBefore = await page.getByText("Task deleted", { exact: false }).count();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  const toastsAfter = await page.getByText("Task deleted", { exact: false }).count();
  check(
    "29. Backspace inside the capture card edits text, deletes nothing",
    toastsAfter <= toastsBefore && (await taskRow("Gamma task").count()) === 1,
    `toasts ${toastsBefore}→${toastsAfter}`,
  );
  await page.keyboard.press("Backspace"); // clear the draft
  await page.keyboard.press("Escape");
  await shot("v2-mut-10-final");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-mut-99-error.png") }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
