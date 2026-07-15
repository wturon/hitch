// One-off check for Backspace/Delete deleting the highlighted Todos row.
// DISPOSABLE, not a maintained test — see ../../AGENTS.md → "Verifying UI changes".
//
//   node desktop/e2e/check-todos-keyboard-delete.mjs
//
// Creates a scratch task, highlights it (hover sets the nav selection, arrows
// keep it), presses Backspace, and asserts the ROW leaves the list (row-scoped
// locator — the undo toast also echoes the title, so plain text queries lie)
// and the "Task deleted" toast appears. Repeats with the Delete key on a second
// scratch task, then checks the add-row and open-capture guards. Only ever
// deletes rows it created (plus any stragglers from earlier runs).

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "todos-keyboard-delete.log");
writeFileSync(LOG, "");

const stamp = Date.now();
const titleA = `e2e-kbdel-a-${stamp}`;
const titleB = `e2e-kbdel-b-${stamp}`;
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

// Row = the list row whose aria-label (the todo title) matches. Toast text
// never matches this — it isn't a role=button with that name.
const rowFor = (title) => page.getByRole("button", { name: new RegExp(title) });

const captureEditor = () =>
  page.locator('[aria-label="Editor"][contenteditable="true"]');

async function createTodo(title) {
  await page.getByRole("button", { name: "Add a todo…" }).click();
  const body = captureEditor();
  await body.waitFor({ timeout: 20000 });
  await body.click();
  await page.keyboard.type(title);
  await page.keyboard.press("Meta+Enter"); // capture → saved
  await page.locator('[aria-label="Start"]').waitFor({ timeout: 10000 });
  await page.locator('[aria-label="Close"]').click();
  // Wait for the dialog to fully unmount — a half-closed editor swallows the
  // next capture's typing (learned the hard way).
  await body.waitFor({ state: "detached", timeout: 10000 });
  await rowFor(title).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400); // nav list settles, active flips back on
}

// Highlight the row via hover (mouse and keyboard share one selection), park
// the pointer so hover can't re-highlight, then press `key`.
async function highlightAndPress(locator, key) {
  await locator.hover();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  await page.keyboard.press(key);
}

try {
  // --- Boot signed-in, go to the Todos tab --------------------------------
  await page.getByRole("button", { name: "Todos" }).first().waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Todos" }).first().click();
  await page.getByRole("button", { name: "Add a todo…" }).waitFor({
    timeout: 15000,
  });
  check("boots + Todos tab renders", true);

  // --- Sweep stragglers from earlier runs (uses the feature to clean up) ---
  const straggler = page.getByRole("button", {
    name: /e2e-kbdel-|Verify keyboard delete todo e2e test/,
  });
  for (let i = 0; i < 5 && (await straggler.count()) > 0; i++) {
    await highlightAndPress(straggler.first(), "Backspace");
    await page.waitForTimeout(500);
  }

  // --- Backspace deletes the highlighted row ------------------------------
  await createTodo(titleA);
  const rowA = rowFor(titleA);
  await rowA.hover();
  await page.mouse.move(1, 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  const ariaA = await rowA.getAttribute("aria-selected");
  check("arrows keep row A highlighted", ariaA === "true", `aria-selected=${ariaA}`);
  await page.screenshot({ path: `${SHOTS}/kbdel-00-highlighted.png` });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(700);
  const remainingA = await rowA.count();
  check("Backspace removes row A", remainingA === 0, `rows=${remainingA}`);
  const toast = await page.getByText("Task deleted", { exact: false }).count();
  check("undo toast appears", toast > 0, `count=${toast}`);
  await page.screenshot({ path: `${SHOTS}/kbdel-01-after-backspace.png` });

  // --- Delete key removes a second row (serial path) ----------------------
  await createTodo(titleB);
  await highlightAndPress(rowFor(titleB), "Delete");
  await page.waitForTimeout(700);
  const remainingB = await rowFor(titleB).count();
  check("Delete removes row B", remainingB === 0, `rows=${remainingB}`);

  // --- Guard: Backspace with the add-row highlighted is a no-op -----------
  const addRow = page.getByRole("button", { name: "Add a todo…" });
  await highlightAndPress(addRow, "Backspace");
  await page.waitForTimeout(400);
  check("Backspace on add-row is a no-op", (await addRow.count()) === 1);

  // --- Guard: Backspace while the capture card is open never deletes ------
  await addRow.click();
  const body = captureEditor();
  await body.waitFor({ timeout: 20000 });
  await body.click();
  await page.keyboard.type("xy");
  const toastsBefore = await page.getByText("Task deleted", { exact: false }).count();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  const toastsAfter = await page.getByText("Task deleted", { exact: false }).count();
  check(
    "Backspace inside capture edits text, deletes nothing",
    toastsAfter <= toastsBefore,
    `toasts ${toastsBefore}→${toastsAfter}`,
  );
  await page.keyboard.press("Backspace"); // clear the draft fully
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOTS}/kbdel-02-final.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/kbdel-99-error.png` }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.pass);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}
