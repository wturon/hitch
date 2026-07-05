// One-off check for the Todos list-view right-click context menu. DISPOSABLE,
// not a maintained test — see ../../AGENTS.md → "Verifying UI changes".
//
//   node desktop/e2e/check-todos-context-menu.mjs
//
// Creates one clearly-named scratch task, drops it into BACKLOG, then RIGHT-
// CLICKS the row and asserts the context menu renders with the expected options
// (Open / Mark done / Copy task path / Archive / Delete). Backlog rows carry
// dnd-kit drag wiring, so this also exercises the context-menu-trigger + drag
// coexistence — the one novel risk. Finally it clicks Archive from the menu and
// asserts the row leaves the list, then cleans up via the Archived sheet.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "todos-context-menu.log");
writeFileSync(LOG, "");

const title = `e2e-ctxmenu-${Date.now()}`;
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
  log("WATCHDOG: run exceeded 150s, exiting");
  cleanup().finally(() => process.exit(2));
}, 150000);

try {
  // --- Boot signed-in, go to the Todos tab --------------------------------
  await page.getByRole("button", { name: "Todos" }).first().waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Todos" }).first().click();
  const addRow = page.getByRole("button", { name: "Add a todo…" });
  await addRow.waitFor({ timeout: 15000 });
  check("boots + Todos tab renders", true);

  // --- Create a scratch todo via the capture card, land it in BACKLOG -----
  await addRow.click();
  await page.waitForTimeout(600);
  const captureBody = page.locator(
    '[aria-label="Editor"][contenteditable="true"]',
  );
  await captureBody.waitFor({ timeout: 20000 });
  await captureBody.click();
  await page.keyboard.type(title);
  await page.keyboard.press("Meta+Enter"); // capture → saved
  await page.locator('[aria-label="Start"]').waitFor({ timeout: 10000 });
  await page.locator('[aria-label="Close"]').click();
  const row = page.getByText(title, { exact: false }).first();
  await row.waitFor({ timeout: 10000 });
  check("scratch todo appears in BACKLOG", true);

  // --- Right-click the row → context menu ---------------------------------
  const rowContainer = row.locator('xpath=ancestor::*[@role="button"][1]');
  await rowContainer.click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor({ timeout: 8000 });
  check("right-click opens a context menu", true);
  await page.screenshot({ path: `${SHOTS}/00-context-menu.png` });

  // --- Assert the expected options are present ----------------------------
  const wanted = ["Open", "Mark done", "Copy task path", "Archive", "Delete"];
  for (const label of wanted) {
    const count = await page
      .getByRole("menuitem", { name: label, exact: true })
      .count();
    check(`context menu offers "${label}"`, count > 0, `count=${count}`);
  }

  // --- Invoke Archive from the menu → row leaves the list -----------------
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.waitForTimeout(600);
  const remaining = await page.getByText(title, { exact: false }).count();
  check(
    "Archive from context menu removes the row",
    remaining === 0,
    `remaining=${remaining}`,
  );
  await page.screenshot({ path: `${SHOTS}/01-after-archive.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // --- Best-effort cleanup: delete the archived scratch todo --------------
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    const archivedBtn = page.getByRole("button", { name: "Archived" }).first();
    if ((await archivedBtn.count()) > 0) {
      await archivedBtn.click();
      await page.waitForTimeout(400);
      const archivedRow = page.getByText(title, { exact: false }).first();
      if ((await archivedRow.count()) > 0) {
        const delBtn = archivedRow
          .locator('xpath=ancestor::*[self::li or @role="listitem" or @role="button"][1]')
          .getByRole("button", { name: /delete/i });
        if ((await delBtn.count()) > 0) await delBtn.first().click();
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
