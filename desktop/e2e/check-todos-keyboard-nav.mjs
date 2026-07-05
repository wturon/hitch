// One-off check for Todos keyboard navigation (feat/todos-keyboard-nav).
// DISPOSABLE — see ../../AGENTS.md → "Verifying UI changes".
//
//   node desktop/e2e/check-todos-keyboard-nav.mjs
//
// Seeds three scratch backlog todos, then drives the new ↑↓/↵ list nav:
//   - ArrowDown highlights the first row (aria-selected + bg-muted)
//   - ArrowDown again moves the highlight down one — and keeps working even
//     though the closed capture dialog restored focus to the Add-a-todo button
//     (the nav guard navigates over buttons on purpose)
//   - ArrowUp moves it back
//   - Enter opens the highlighted todo's dialog
// Cleans up by archiving + deleting the scratch rows.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "todos-keyboard-nav.log");
writeFileSync(LOG, "");

const stamp = Date.now();
const titles = [`e2e-kbd-A-${stamp}`, `e2e-kbd-B-${stamp}`, `e2e-kbd-C-${stamp}`];
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

// The row container (role=button) for a given title.
const rowFor = (title) =>
  page
    .getByText(title, { exact: false })
    .first()
    .locator('xpath=ancestor::*[@role="button"][1]');

const isSelected = async (title) =>
  (await rowFor(title).getAttribute("aria-selected")) === "true";

try {
  // --- Boot signed-in, go to the Todos tab --------------------------------
  await page
    .getByRole("button", { name: "Todos" })
    .first()
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Todos" }).first().click();
  const addRow = page.getByRole("button", { name: "Add a todo…" });
  await addRow.waitFor({ timeout: 15000 });
  check("boots + Todos tab renders", true);

  // --- Seed three scratch backlog todos -----------------------------------
  for (const title of titles) {
    await addRow.click();
    await page.waitForTimeout(400);
    const body = page.locator('[aria-label="Editor"][contenteditable="true"]');
    await body.waitFor({ timeout: 20000 });
    await body.click();
    await page.keyboard.type(title);
    await page.keyboard.press("Meta+Enter");
    await page.locator('[aria-label="Start"]').waitFor({ timeout: 10000 });
    await page.locator('[aria-label="Close"]').click();
    await rowFor(title).waitFor({ timeout: 10000 });
  }
  check("seeded 3 backlog todos", true);

  // Newest capture lands at the top of BACKLOG, so render order is C, B, A.
  const [first, second] = [titles[2], titles[1]];

  // --- ArrowDown highlights the first row ---------------------------------
  // The capture flow leaves focus on the Add-a-todo button; blur to a defined
  // start state. (The nav then survives stray button focus regardless.)
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  check("ArrowDown highlights the first row", await isSelected(first), first);
  await page.screenshot({ path: `${SHOTS}/00-first-highlighted.png` });

  // --- ArrowDown moves the highlight down one -----------------------------
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  check(
    "second ArrowDown moves highlight to row 2",
    (await isSelected(second)) && !(await isSelected(first)),
    second,
  );

  // --- ArrowUp moves it back ----------------------------------------------
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(150);
  check(
    "ArrowUp moves highlight back to row 1",
    (await isSelected(first)) && !(await isSelected(second)),
    first,
  );

  // --- Enter opens the highlighted todo -----------------------------------
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const dialog = page.getByRole("dialog");
  const dialogOpen = (await dialog.count()) > 0;
  const dialogHasTitle =
    dialogOpen && (await dialog.getByText(first, { exact: false }).count()) > 0;
  check("Enter opens the highlighted todo's dialog", dialogHasTitle, first);
  await page.screenshot({ path: `${SHOTS}/01-dialog-open.png` });

  // --- Close restores the list --------------------------------------------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const dialogClosed = (await page.getByRole("dialog").count()) === 0;
  check("Escape closes the dialog back to the list", dialogClosed);
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // --- Best-effort cleanup: archive then delete the scratch rows ----------
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    for (const title of titles) {
      const row = rowFor(title);
      if ((await row.count()) === 0) continue;
      await row.click({ button: "right" });
      const archive = page.getByRole("menuitem", {
        name: "Archive",
        exact: true,
      });
      if ((await archive.count()) > 0) {
        await archive.click();
        await page.waitForTimeout(300);
      } else {
        await page.keyboard.press("Escape");
      }
    }
    const archivedBtn = page.getByRole("button", { name: "Archived" }).first();
    if ((await archivedBtn.count()) > 0) {
      await archivedBtn.click();
      await page.waitForTimeout(400);
      for (const title of titles) {
        const archivedRow = page.getByText(title, { exact: false }).first();
        if ((await archivedRow.count()) === 0) continue;
        const delBtn = archivedRow
          .locator(
            'xpath=ancestor::*[self::li or @role="listitem" or @role="button"][1]',
          )
          .getByRole("button", { name: /delete/i });
        if ((await delBtn.count()) > 0) await delBtn.first().click();
        await page.waitForTimeout(200);
      }
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
