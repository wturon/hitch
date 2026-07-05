// One-off check for the capture-draft-recovery amendment to Todos v1 Decision 4:
// esc in the capture stage now closes INSTANTLY (no armed/double-esc guard, no
// red "Discard this capture?" footer), and the typed body is preserved as a
// localStorage recovery draft — restored the next time capture opens, cleared
// on a successful ⌘⏎ save. DISPOSABLE, not a maintained test — see
// ../../AGENTS.md → "Verifying UI changes".
//
//   HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 \
//     node desktop/e2e/check-capture-draft-recovery.mjs
//
// Confined to one scratch todo, deleted at the end via the saved dialog's
// ⋯ Delete.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "capture-draft-recovery.log");
writeFileSync(LOG, "");

const title = `e2e-draft-recovery-${Date.now()}`;
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
  log("WATCHDOG: run exceeded 120s, exiting");
  cleanup().finally(() => process.exit(2));
}, 120000);

const dialogPopup = () => page.locator('[data-slot="todo-dialog"]');
const captureBody = () =>
  page.locator('[aria-label="Editor"][contenteditable="true"]');
const addRow = () => page.getByRole("button", { name: "Add a todo…" });

try {
  // --- Boot signed-in, go to the Todos tab --------------------------------
  await page.getByRole("button", { name: "Todos" }).first().waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Todos" }).first().click();
  await addRow().waitFor({ timeout: 15000 });
  check("boots + Todos tab renders", true);

  // --- Open capture, type, esc — closes instantly, no red footer ---------
  await addRow().click();
  await captureBody().waitFor({ timeout: 20000 });
  await captureBody().click();
  await page.keyboard.type(title);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/00-typed.png` });
  const noArmedFooterBeforeEsc =
    (await page.getByText("Discard this capture?").count()) === 0;
  check(
    "no armed/destructive footer appears while typing",
    noArmedFooterBeforeEsc,
  );

  const escStart = Date.now();
  await page.keyboard.press("Escape");
  await dialogPopup().waitFor({ state: "detached", timeout: 3000 });
  const escMs = Date.now() - escStart;
  check(
    "single esc closes the capture card instantly (no second esc needed)",
    true,
    `closed in ${escMs}ms`,
  );
  const rowGone = (await page.getByText(title, { exact: false }).count()) === 0;
  check("esc-closed capture does not create a todo row", rowGone);

  // --- Reopen capture — the typed text is restored as a recovery draft ---
  await addRow().click();
  await captureBody().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
  const restoredText = (await captureBody().innerText()).trim();
  await page.screenshot({ path: `${SHOTS}/01-restored.png` });
  check(
    "reopening capture restores the localStorage draft",
    restoredText === title,
    `restored="${restoredText}"`,
  );

  // --- ⌘⏎ saves — transforms to the saved stage, clears the draft --------
  await page.keyboard.press("Meta+Enter");
  await page.locator('[aria-label="Start"]').waitFor({ timeout: 10000 });
  check("⌘⏎ transforms capture → saved stage (Start footer)", true);
  await page.screenshot({ path: `${SHOTS}/02-saved.png` });
  await page.locator('[aria-label="Close"]').click();
  await dialogPopup().waitFor({ state: "detached", timeout: 8000 });
  const row = page.getByText(title, { exact: false }).first();
  await row.waitFor({ timeout: 10000 });
  check("saved todo appears in the list", true);

  // --- Reopen a FRESH capture — the draft was cleared on save ------------
  await addRow().click();
  await captureBody().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
  const clearedText = (await captureBody().innerText()).trim();
  await page.screenshot({ path: `${SHOTS}/03-cleared.png` });
  check(
    "a successful ⌘⏎ save clears the recovery draft (fresh capture opens empty)",
    clearedText === "",
    `body="${clearedText}"`,
  );
  await page.keyboard.press("Escape");
  await dialogPopup().waitFor({ state: "detached", timeout: 3000 });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // --- Best-effort cleanup: delete the scratch todo -----------------------
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    const row = page.getByText(title, { exact: false }).first();
    if (await row.count()) {
      await row.click();
      await page.locator('[aria-label="Todo actions"]').waitFor({ timeout: 8000 });
      await page.locator('[aria-label="Todo actions"]').click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.waitForTimeout(400);
      log("cleanup: deleted scratch todo via ⋯ Delete");
    } else {
      log("cleanup: scratch todo not found (may already be gone)");
    }
  } catch (e) {
    log(`cleanup: best-effort delete failed — ${String(e)}`);
  }
  await cleanup();
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.pass).length;
log(`\n${results.length - failed}/${results.length} checks passed.`);
log(`Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
