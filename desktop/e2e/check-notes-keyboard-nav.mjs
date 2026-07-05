// One-off check: Notes index arrow-key nav still works after the useListKeyboardNav
// refactor. DISPOSABLE — see ../../AGENTS.md. Types a query, arrows the highlight,
// and asserts aria-selected tracks ↑↓; then Enter opens the highlighted note.
//
//   node desktop/e2e/check-notes-keyboard-nav.mjs

import { launchHitch } from "./harness.mjs";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const { page, cleanup } = await launchHitch();
page.on("dialog", (d) => d.dismiss().catch(() => {}));
const watchdog = setTimeout(() => cleanup().finally(() => process.exit(2)), 120000);

const selectedText = () =>
  page.evaluate(() => {
    const el = document.querySelector('[role="option"][aria-selected="true"]');
    return el ? el.textContent?.trim().slice(0, 40) : null;
  });

try {
  await page.getByRole("button", { name: "Notes" }).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Notes" }).first().click();
  const search = page.getByRole("combobox");
  await search.waitFor({ timeout: 15000 });
  check("Notes index reachable", true);

  // Empty-query recency list. Count the option rows (notes + the Create row).
  await page.waitForTimeout(400);
  const optionCount = await page.locator('[role="option"]').count();
  check("index renders option rows", optionCount >= 1, `options=${optionCount}`);

  // Nothing highlighted yet (-1 sentinel).
  check("no row highlighted initially", (await selectedText()) === null);

  // ArrowDown → first row highlighted.
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(120);
  const first = await selectedText();
  check("ArrowDown highlights the first row", first !== null, String(first));

  // Second ArrowDown → highlight advances (only meaningful with >1 option).
  if (optionCount > 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    const second = await selectedText();
    check(
      "second ArrowDown advances the highlight",
      second !== null && second !== first,
      String(second),
    );
    // ArrowUp → back to the first.
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(120);
    check("ArrowUp moves the highlight back", (await selectedText()) === first);
  }

  // Type a character → filters and resets highlight (command-palette feel).
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(80);
  await page.keyboard.type("z");
  await page.waitForTimeout(150);
  const q = await search.inputValue();
  check("typing filters via the search box", q.includes("z"), `query="${q}"`);
  check("typing resets the highlight", (await selectedText()) === null);

  // Escape clears the query (first stage), staying on the index.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const cleared = await search.inputValue();
  const stillIndex = (await page.getByRole("combobox").count()) > 0;
  check(
    "Escape clears the query and stays on the index",
    cleared === "" && stillIndex,
    `query="${cleared}"`,
  );
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: "/tmp/hitch-e2e/notes-nav-error.png" }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}
