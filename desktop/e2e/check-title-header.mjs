// One-off check for the title de-emphasis restructure (feat/title-deemphasis):
// the TodoDialog's saved stage presents the title as window chrome — a small
// muted single-line input in a slim header row, inline with ⋯/✕ — while the
// body is the card's largest, darkest element. DISPOSABLE, not a maintained
// test — see ../../AGENTS.md → "Verifying UI changes".
//
//   node desktop/e2e/check-title-header.mjs
//
// Verifies: (1) the capture stage stays chrome-free (no header, no title);
// (2) ⌘⏎ → saved stage shows the seed title in the header input inline with
// ⋯/✕ and the body text verbatim; (3) editing the title through the header
// persists into the raw frontmatter, and the raw view shows ⋯/✕ but NO title
// input; (4) a very long title ellipsizes on one line without displacing the
// buttons. Everything is confined to one scratch task, deleted at the end.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "title-header.log");
writeFileSync(LOG, "");

const stamp = `e2e-title-hdr-${Date.now()}`;
// Two sentences: the first seeds the title (first 6 words), the whole thing
// must land in the body verbatim.
const sentence1 = `${stamp} flickers when rows cross boundaries.`;
const sentence2 = "The second sentence must stay verbatim in the body.";
const body = `${sentence1} ${sentence2}`;
// deriveTitleFromBody: first non-empty line, first 6 words.
const expectedSeed = body.split(" ").slice(0, 6).join(" ");

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

const titleInput = page.locator('input[aria-label="Todo title"]');
const actionsBtn = page.locator('[aria-label="Todo actions"]');
const closeBtn = page.locator('[aria-label="Close"]');

async function openRawView() {
  await actionsBtn.click();
  await page.getByRole("menuitem", { name: "Raw markdown" }).click();
  await page
    .locator('textarea[aria-label="Todo content"]')
    .waitFor({ timeout: 8000 });
}
async function openFormattedView() {
  await actionsBtn.click();
  await page.getByRole("menuitem", { name: "Formatted view" }).click();
}

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

  // --- 1. Capture stage: completely chrome-free ---------------------------
  await addRow.click();
  const captureBody = page.locator(
    '[aria-label="Editor"][contenteditable="true"]',
  );
  await captureBody.waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);
  const captureTitleCount = await titleInput.count();
  const captureActionsCount = await actionsBtn.count();
  check(
    "capture stage is chrome-free (no title input, no ⋯)",
    captureTitleCount === 0 && captureActionsCount === 0,
    `title=${captureTitleCount} actions=${captureActionsCount}`,
  );
  await page.screenshot({ path: `${SHOTS}/th-00-capture.png` });

  // --- 2. ⌘⏎ → saved: header shows the seed title inline with ⋯/✕ ---------
  await captureBody.click();
  await page.keyboard.type(body);
  await page.keyboard.press("Meta+Enter");
  await titleInput.waitFor({ timeout: 10000 });
  await page.waitForTimeout(400); // let the grow transform settle
  const seed = await titleInput.inputValue();
  check(
    "saved stage: header input carries the seed title",
    seed === expectedSeed,
    `seed="${seed}" expected="${expectedSeed}"`,
  );
  // Same row: the title input and the ⋯/✕ buttons must vertically overlap.
  const [tBox, aBox, cBox] = await Promise.all([
    titleInput.boundingBox(),
    actionsBtn.boundingBox(),
    closeBtn.boundingBox(),
  ]);
  const overlaps = (x, y) =>
    x && y && x.y < y.y + y.height && y.y < x.y + x.height;
  check(
    "title input is inline with ⋯ and ✕ (one header row)",
    overlaps(tBox, aBox) && overlaps(tBox, cBox),
    `title.y=${tBox?.y} actions.y=${aBox?.y} close.y=${cBox?.y}`,
  );
  const bodyText = await captureBody.textContent();
  check(
    "body text is verbatim what was typed",
    (bodyText ?? "").includes(sentence1) &&
      (bodyText ?? "").includes(sentence2),
    `body="${(bodyText ?? "").slice(0, 80)}…"`,
  );
  await page.screenshot({ path: `${SHOTS}/th-01-saved-header.png` });

  // --- 3. Edit the title via the header, verify it persists ---------------
  const customTitle = `${stamp} custom name`;
  await titleInput.click();
  await titleInput.fill(customTitle);
  await captureBody.click(); // blur the title input
  await page.waitForTimeout(200);
  await openRawView();
  const raw = await page
    .locator('textarea[aria-label="Todo content"]')
    .inputValue();
  check(
    "edited title lands in the raw frontmatter",
    raw.includes(`title: ${customTitle}`),
    `raw head="${raw.split("\n").slice(0, 3).join(" / ")}"`,
  );
  const rawTitleCount = await titleInput.count();
  const rawActions =
    (await actionsBtn.count()) > 0 && (await closeBtn.count()) > 0;
  check(
    "raw view: ⋯/✕ present but NO title input",
    rawTitleCount === 0 && rawActions,
    `title=${rawTitleCount} actions=${rawActions}`,
  );
  await page.screenshot({ path: `${SHOTS}/th-02-raw-view.png` });

  // --- 4. Long title ellipsizes on one line, buttons stay put -------------
  const longTitle = `${stamp} an extremely long machine generated title that keeps going and going far past the width of the header row of the dialog card`;
  const rawArea = page.locator('textarea[aria-label="Todo content"]');
  await rawArea.fill(`---\ntitle: ${longTitle}\n---\n${body}\n`);
  await page.waitForTimeout(300);
  await openFormattedView();
  await titleInput.waitFor({ timeout: 8000 });
  const longVal = await titleInput.inputValue();
  const metrics = await titleInput.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    height: el.getBoundingClientRect().height,
  }));
  const [aBox2, cBox2, tBox2] = await Promise.all([
    actionsBtn.boundingBox(),
    closeBtn.boundingBox(),
    titleInput.boundingBox(),
  ]);
  check(
    "long title: single line, ellipsized (overflowing input)",
    longVal === longTitle &&
      metrics.scrollWidth > metrics.clientWidth &&
      metrics.height < 24,
    `scroll=${metrics.scrollWidth} client=${metrics.clientWidth} h=${metrics.height}`,
  );
  check(
    "long title: ⋯/✕ not displaced (still inline, inside the card)",
    overlaps(tBox2, aBox2) && overlaps(tBox2, cBox2) && cBox2.x < 1600,
    `actions.y=${aBox2?.y} close.y=${cBox2?.y}`,
  );
  await page.screenshot({ path: `${SHOTS}/th-03-long-title.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/th-99-error.png` }).catch(() => {});
} finally {
  // --- Best-effort cleanup: delete the scratch todo via ⋯ → Delete --------
  try {
    if (await actionsBtn.count()) {
      await actionsBtn.click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.waitForTimeout(600);
      log("cleanup: deleted scratch todo via ⋯ menu");
    } else {
      // Dialog already closed — reopen from the list if the row survives.
      await page.keyboard.press("Escape").catch(() => {});
      const row = page.getByText(stamp, { exact: false }).first();
      if (await row.count()) {
        await row.click();
        await actionsBtn.waitFor({ timeout: 8000 });
        await actionsBtn.click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await page.waitForTimeout(600);
        log("cleanup: deleted scratch todo via reopened dialog");
      } else {
        log("cleanup: scratch todo not found (may already be gone)");
      }
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
