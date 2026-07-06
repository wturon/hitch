// One-off check for the undo-toast feedback on hard-to-reverse actions.
// DISPOSABLE, not a maintained test — see ../../AGENTS.md → "Verifying UI changes".
//
//   node desktop/e2e/check-undo-toasts.mjs
//
// Exercises what the undo-toast layer promises:
//   1. Marking a todo done shows a "Task marked done" toast with an Undo button.
//   2. ⌘Z while the toast is up reverts the check (row un-checks). The toast's
//      Undo button runs the exact same runUndo(), so the keyboard path proving
//      out covers the button too — and it avoids racing the toast's on-screen
//      position against the rows beneath it.
//   3. ⌘Z is inert once the toast has auto-closed (the row stays done).
//   4. Deleting a todo shows a "Task deleted" toast whose Undo brings it back.
//
// Marking is driven through the row CHECKBOX (left edge, stopPropagation — can't
// open the dialog); done-state is read from the checkbox's aria-checked.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "undo-toasts.log");
writeFileSync(LOG, "");

const title = `e2e-undo-${Date.now()}`;
const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const { page, cleanup } = await launchHitch();
page.on("dialog", (d) => d.dismiss().catch(() => {}));

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 180s, exiting");
  cleanup().finally(() => process.exit(2));
}, 180000);

const rowCount = () => page.getByText(title, { exact: false }).count();
// Re-locate the row's checkbox fresh — an undo/redo moves the row between the
// BACKLOG and DONE groups (different DOM subtrees), so a cached chain goes stale.
const checkbox = () =>
  page
    .getByText(title, { exact: false })
    .first()
    .locator('xpath=ancestor::*[@role="button"][1]')
    .getByRole("checkbox");
const isDone = async () => {
  await checkbox().waitFor({ timeout: 8000 });
  return (await checkbox().getAttribute("aria-checked")) === "true";
};

try {
  // --- Boot signed-in, go to Todos, create a scratch todo in BACKLOG -------
  await page.getByRole("button", { name: "Todos" }).first().waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Todos" }).first().click();
  const addRow = page.getByRole("button", { name: "Add a todo…" });
  await addRow.waitFor({ timeout: 15000 });
  await addRow.click();
  await page.waitForTimeout(600);
  const captureBody = page.locator(
    '[aria-label="Editor"][contenteditable="true"]',
  );
  await captureBody.waitFor({ timeout: 20000 });
  await captureBody.click();
  await page.keyboard.type(title);
  await page.keyboard.press("Meta+Enter");
  await page.locator('[aria-label="Start"]').waitFor({ timeout: 10000 });
  await page.locator('[aria-label="Close"]').click();
  await checkbox().waitFor({ timeout: 10000 });
  check("scratch todo appears in BACKLOG", true);

  // --- Mark done via the checkbox → toast with Undo -----------------------
  await checkbox().click();
  await page.getByText("Task marked done", { exact: false }).waitFor({
    timeout: 6000,
  });
  check("marking done shows 'Task marked done' toast", true);
  check(
    "toast offers an Undo button",
    (await page.getByRole("button", { name: "Undo" }).count()) > 0,
  );
  check("checkbox reads as done", (await isDone()) === true);
  await page.screenshot({ path: `${SHOTS}/00-done-toast.png` });

  // --- ⌘Z while the toast is up → the check is reverted -------------------
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(700);
  check("⌘Z undoes while the toast is visible", (await isDone()) === false);
  await page.screenshot({ path: `${SHOTS}/01-after-undo.png` });

  // --- ⌘Z is inert once the toast has auto-closed -------------------------
  await checkbox().click(); // mark done again
  await page.getByText("Task marked done", { exact: false }).waitFor({
    timeout: 6000,
  });
  await page.waitForTimeout(6200); // let the toast auto-close (6s duration)
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  check(
    "⌘Z with no toast leaves the done state untouched",
    (await isDone()) === true,
  );
  // reset to not-done via the checkbox for a clean delete step
  await checkbox().click();
  await page.waitForTimeout(500);

  // --- Delete via context menu → toast whose Undo restores the row -------
  await checkbox()
    .locator("xpath=ancestor::*[@role='button'][1]")
    .click({ button: "right" });
  await page.getByRole("menu").waitFor({ timeout: 8000 });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByText("Task deleted", { exact: false }).waitFor({
    timeout: 6000,
  });
  check(
    "deleting a todo shows 'Task deleted' toast",
    (await rowCount()) === 0,
    `rows=${await rowCount()}`,
  );
  await page.screenshot({ path: `${SHOTS}/02-delete-toast.png` });
  await page.getByRole("button", { name: "Undo" }).first().click();
  await page.waitForTimeout(900);
  check(
    "Undo restores the deleted todo",
    (await rowCount()) > 0,
    `rows=${await rowCount()}`,
  );
  await page.screenshot({ path: `${SHOTS}/03-after-delete-undo.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // Best-effort cleanup: delete the scratch todo for good.
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    if ((await rowCount()) > 0) {
      await checkbox()
        .locator("xpath=ancestor::*[@role='button'][1]")
        .click({ button: "right" });
      const del = page.getByRole("menuitem", { name: "Delete", exact: true });
      if ((await del.count()) > 0) await del.click();
    }
  } catch (e) {
    log(`cleanup note: ${String(e)}`);
  }
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.pass);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}
