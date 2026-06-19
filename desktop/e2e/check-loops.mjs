// Disposable one-off check for the Loops tab (Phase 2). Launches the real app,
// switches to Loops, creates a scratch loop, opens its detail, screenshots each
// screen, then deletes the scratch loop. NOT a maintained test — see AGENTS.md.
//
//   node desktop/e2e/check-loops.mjs

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = "/tmp/hitch-e2e/shots";
mkdirSync(SHOTS, { recursive: true });
const LOG = "/tmp/hitch-e2e/loops.log";
writeFileSync(LOG, "");

const title = `e2e-loop-${Date.now()}`;
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

try {
  await page.locator('[aria-label="Add task"]').first().waitFor({ timeout: 25000 });
  check("boots signed-in", true);

  // Switch to the Loops tab.
  const loopsTab = page.getByRole("button", { name: "Loops" }).first();
  await loopsTab.waitFor({ timeout: 10000 });
  await loopsTab.click();
  const search = page.getByPlaceholder("Search loops, or type to create…");
  await search.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/loops-01-index.png` });
  check("Loops tab renders index", true);

  // Create a loop by typing + Enter.
  await search.click();
  await search.fill(title);
  await search.press("Enter");
  const heading = page.getByRole("heading", { name: title });
  await heading.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/loops-02-detail.png` });
  check("creates a loop and opens detail", true);

  // Edit the prompt body.
  const prompt = page.locator('.hitch-mdx-content[contenteditable="true"]').first();
  await prompt.waitFor({ timeout: 8000 });
  await prompt.click();
  await page.keyboard.type("Check open PRs and summarize.");
  check("prompt is editable", true);

  // --- Trigger script modal: open, Run test, Save & trust -------------------
  await page.getByText("Add a trigger script").click();
  const runTest = page.getByRole("button", { name: "Run test" });
  await runTest.waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/loops-06-trigger-modal.png` });
  await runTest.click();
  // The starter script is all comments after `set -euo pipefail` → exit 0.
  const wouldRun = page.getByText("would run", { exact: false }).first();
  await wouldRun.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/loops-07-run-test.png` });
  check("trigger Run test → exit 0 / would run", true);
  await page.getByRole("button", { name: "Save & trust" }).click();
  // Modal closes; the detail now shows the trigger.sh card (Trusted).
  const triggerCard = page.getByText("Runs only when trigger.sh exits 0.", {
    exact: false,
  });
  await triggerCard.waitFor({ timeout: 10000 });
  check("Save & trust writes trigger.sh + shows trusted card", true);
  await page.screenshot({ path: `${SHOTS}/loops-08-trigger-saved.png` });

  // Toggle enabled.
  const toggle = page.getByRole("switch");
  await toggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/loops-03-enabled.png` });
  const enabled = await toggle.getAttribute("aria-checked");
  check("enable toggle flips", enabled === "true", `aria-checked=${enabled}`);

  // Back to index — the new card should be there.
  await page.getByRole("button", { name: "Back to loops" }).click();
  await page.waitForTimeout(300);
  const card = page.getByText(title, { exact: false }).first();
  await card.waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/loops-04-card.png` });
  check("loop card shows on index", true);

  // Activity tab renders.
  await page.getByRole("button", { name: "Activity" }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/loops-05-activity.png` });
  check("Activity tab renders", true);

  // --- Command palette: the loop is searchable + has a Loops group -----------
  await page.keyboard.press("Meta+k");
  const palInput = page.getByPlaceholder(
    "Search tasks, notes, projects, settings, or actions…",
  );
  await palInput.waitFor({ timeout: 8000 });
  await palInput.fill(title.slice(0, 14));
  await page.waitForTimeout(300);
  const loopsHeading = page.getByText("Loops", { exact: true });
  const palLoopRow = page.getByText(title, { exact: false }).last();
  await palLoopRow.waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/loops-09-palette.png` });
  check("loop is searchable in ⌘K palette", (await loopsHeading.count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/loops-99-error.png` }).catch(() => {});
} finally {
  // Best-effort cleanup: delete EVERY e2e scratch loop (this run's + any
  // orphans left by earlier runs), so the test project stays clean.
  try {
    // Make sure we're on the index (Esc out of detail/palette if needed).
    await page.keyboard.press("Escape").catch(() => {});
    const back = page.getByRole("button", { name: "Back to loops" });
    if (await back.count()) await back.click();
    await page.getByRole("button", { name: "Automations" }).first().click();
    await page.waitForTimeout(200);
    for (let i = 0; i < 20; i++) {
      const menuBtn = page.locator('[aria-label^="Actions for e2e-loop-"]').first();
      if (!(await menuBtn.count())) break;
      await menuBtn.click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.waitForTimeout(250);
    }
  } catch {
    /* clearly named scratch loops */
  }
  await cleanup();
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.pass).length;
log(`\n${results.length - failed}/${results.length} checks passed.`);
log(`Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
