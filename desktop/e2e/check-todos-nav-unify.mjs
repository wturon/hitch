// DISPOSABLE one-off check for the unified Todos selection (see AGENTS.md).
//   node desktop/e2e/check-todos-nav-unify.mjs
//
// Verifies the review follow-up: the bg-muted highlight and DOM focus are ONE
// selection. ↑↓ carry focus with the highlight; ←→ traverse the highlighted
// row's own controls (row body → done → chat) without leaving the row; and any
// focus landing in a row (focusin) adopts it as the selection. Creates a scratch
// backlog row, drives the keys, asserts activeElement + aria-current, and shoots
// a hovered chat row to confirm the chip no longer clips the tags.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "todos-nav-unify.log");
writeFileSync(LOG, "");

const stamp = Date.now();
const title = `e2e-nav-${stamp}`;
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
  log("WATCHDOG: exceeded 180s");
  cleanup().finally(() => process.exit(2));
}, 180000);

const rowFor = (t) => page.getByRole("button", { name: new RegExp(t) });
const captureEditor = () =>
  page.locator('[aria-label="Editor"][contenteditable="true"]');

// Describe document.activeElement relative to the nav list: which row owns it
// (nearest [data-idx]) and whether that element is itself the row body.
const activeInfo = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return { tag: null };
    const row = a.closest("[data-idx]");
    return {
      tag: a.tagName.toLowerCase(),
      role: a.getAttribute("role"),
      isRowBody: a === row,
      rowIdx: row ? row.getAttribute("data-idx") : null,
      rowCurrent: row ? row.getAttribute("aria-current") : null,
    };
  });

async function createTodo(t) {
  await page.getByRole("button", { name: "Add a todo…" }).click();
  const body = captureEditor();
  await body.waitFor({ timeout: 20000 });
  await body.click();
  await page.keyboard.type(t);
  await page.keyboard.press("Meta+Enter");
  await page.locator('[aria-label="Start"]').waitFor({ timeout: 10000 });
  await page.locator('[aria-label="Close"]').click();
  await body.waitFor({ state: "detached", timeout: 10000 });
  await rowFor(t).waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
}

try {
  await page.getByRole("button", { name: "Todos" }).first().waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Todos" }).first().click();
  await page.getByRole("button", { name: "Add a todo…" }).waitFor({
    timeout: 15000,
  });

  await createTodo(title);
  const row = rowFor(title);
  const idx = Number(await row.getAttribute("data-idx"));
  check("scratch row has a nav index", Number.isInteger(idx), `idx=${idx}`);

  // --- ↑↓ carry focus with the highlight ----------------------------------
  await row.hover(); // hover selects the scratch row (no focus yet)
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowUp"); // → row above, focus should follow
  await page.waitForTimeout(150);
  const up = await activeInfo();
  check(
    "ArrowUp moves focus onto a row AND highlights the same row",
    up.rowIdx === String(idx - 1) && up.rowCurrent === "true" && up.isRowBody,
    JSON.stringify(up),
  );

  // --- ←→ traverse the highlighted row's own controls ---------------------
  await row.hover();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowRight"); // step onto the row body
  const r1 = await activeInfo();
  check(
    "ArrowRight (from hover) lands on the row body",
    r1.isRowBody && r1.rowIdx === String(idx),
    JSON.stringify(r1),
  );
  await page.keyboard.press("ArrowRight"); // → the done checkbox
  const r2 = await activeInfo();
  check(
    "ArrowRight moves into the row's controls (done checkbox), same row",
    r2.role === "checkbox" && r2.rowIdx === String(idx) && r2.rowCurrent === "true",
    JSON.stringify(r2),
  );
  await page.keyboard.press("ArrowLeft"); // ← back to the row body
  const r3 = await activeInfo();
  check(
    "ArrowLeft returns to the row body without leaving the row",
    r3.isRowBody && r3.rowIdx === String(idx),
    JSON.stringify(r3),
  );

  // --- focusin adopts the focused row as the selection --------------------
  // Focus row 0 directly (the add-row is a plain button, no checkbox). Selection
  // is currently on row 1 from the ←→ walk above, so this proves focus moving to
  // a DIFFERENT row drags the highlight along.
  await page.evaluate(() => {
    document.querySelector('[data-idx="0"]')?.focus();
  });
  await page.waitForTimeout(150);
  const foc = await activeInfo();
  check(
    "focusing a control adopts its row as the highlight (focusin sync)",
    foc.rowIdx === "0" && foc.rowCurrent === "true",
    JSON.stringify(foc),
  );

  // --- Clipping: hover a chat row, confirm tags aren't covered ------------
  // Best-effort: only rows with a linked chat show the expanding "Open chat"
  // chip. Screenshot for the eyeball check.
  const chatRow = page.getByRole("button", { name: /Open chat/ }).first();
  if ((await chatRow.count()) > 0) {
    const container = chatRow.locator("xpath=ancestor::*[@data-idx][1]");
    await container.hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/nav-unify-chip-hover.png` });
    check("captured a hovered chat row for the clipping eyeball check", true);
  } else {
    log("note: no chat-linked row present to screenshot the chip");
  }
  await page.screenshot({ path: `${SHOTS}/nav-unify-final.png` });

  // --- Clean up the scratch row -------------------------------------------
  await row.hover();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(500);
  check("scratch row cleaned up", (await rowFor(title).count()) === 0);
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/nav-unify-error.png` }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.pass);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}
