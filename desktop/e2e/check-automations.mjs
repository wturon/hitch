// One-off QA check for the Routines/Automations feature (Routines Part I).
// Drives the real app to verify the automation lifecycle that does NOT need a
// daemon spawn: create → render in index → edit → disable/enable → run-now
// affordance → delete. See ../../AGENTS.md → "Verifying UI changes".
//
//   node desktop/e2e/check-automations.mjs
//
// IMPORTANT: this never clicks "Run now". The dev daemon is live against the
// same Convex backend, so an actual run-now would make it spawn a real agent in
// the repo. We assert the affordance is present + enabled (incl. while paused)
// but never trigger it. The full enqueue→claim→done path is covered by the
// daemon smoke tests (smoke:automation-*).
//
// Creates a clearly-named scratch automation and soft-deletes it at the end.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = "/tmp/hitch-e2e/automations";
mkdirSync(SHOTS, { recursive: true });
const LOG = "/tmp/hitch-e2e/automations.log";
writeFileSync(LOG, "");

const name = `e2e-auto-${Date.now()}`;
const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (label, pass, detail = "") => {
  results.push({ name: label, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const { page, cleanup } = await launchHitch({ profile: "automations" });
page.on("dialog", (d) => d.dismiss().catch(() => {}));

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 150s, exiting");
  cleanup().finally(() => process.exit(2));
}, 150000);

try {
  // --- Boot signed-in -------------------------------------------------------
  const addTask = page.locator('[aria-label="Add task"]').first();
  await addTask.waitFor({ timeout: 30000 });
  check("boots signed-in (board renders)", true);

  // --- Navigate to the Automations tab --------------------------------------
  await page.getByRole("button", { name: "Automations" }).first().click();
  // Either the empty state CTA or an existing list + "New automation" button.
  const newBtn = page.getByRole("button", { name: "New automation" }).first();
  await newBtn.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/01-automations-tab.png` });
  check("Automations tab opens", true);

  // --- Create an automation -------------------------------------------------
  await newBtn.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 8000 });
  const nameInput = dialog.locator('input[placeholder="Review open PRs"]');
  await nameInput.fill(name);
  const prompt = dialog.locator("textarea");
  await prompt.fill("QA scratch automation. Do nothing.");
  await page.screenshot({ path: `${SHOTS}/02-new-dialog.png` });
  // Footer should echo the default daily schedule in plain English.
  const footerOk = await dialog.getByText(/Daily at/i).first().count();
  check("new dialog echoes plain-English schedule", footerOk > 0);
  await dialog.getByRole("button", { name: "Create automation" }).click();
  await dialog.waitFor({ state: "detached", timeout: 8000 });

  // --- Renders in the index -------------------------------------------------
  const row = page.getByRole("button", { name: new RegExp(name) }).first();
  await row.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/03-index-row.png` });
  check("created automation appears in index", true);

  // The detail pane auto-selects the new automation; its title input holds the name.
  const titleInput = page.locator(`input[value="${name}"]`).first();
  await titleInput.waitFor({ timeout: 8000 });
  const scheduleStrip = page.getByText(/Daily at 9:00 AM/i).first();
  check(
    "detail shows schedule strip in plain English",
    (await scheduleStrip.count()) > 0,
  );

  // --- Edit: change the prompt and save -------------------------------------
  const detailPrompt = page
    .locator('textarea[placeholder^="Describe exactly"]')
    .first();
  await detailPrompt.click();
  await detailPrompt.fill("QA scratch automation v2. Still do nothing.");
  const saveBtn = page.getByRole("button", { name: "Save" });
  await saveBtn.waitFor({ timeout: 5000 });
  const saveEnabled = await saveBtn.isEnabled();
  check("Save enables when prompt is dirty", saveEnabled);
  await saveBtn.click();
  // After save the draft matches the file again → Save disables.
  await page
    .waitForFunction(
      () => {
        const btns = [...document.querySelectorAll("button")];
        const save = btns.find((b) => b.textContent?.trim() === "Save");
        return save ? save.disabled : false;
      },
      { timeout: 8000 },
    )
    .then(() => check("Save disables after a successful save", true))
    .catch(() => check("Save disables after a successful save", false));
  await page.screenshot({ path: `${SHOTS}/04-after-edit.png` });

  // --- Disable via the Status toggle ----------------------------------------
  await page.getByRole("button", { name: "Status" }).first().click();
  const paused = page.getByText("Paused", { exact: true }).first();
  await paused.waitFor({ timeout: 6000 });
  check("Status toggle pauses the automation", true);

  // --- Run-now affordance stays available while paused (do NOT click) -------
  const runNowButtons = page.getByRole("button", { name: "Run now" });
  const runNowCount = await runNowButtons.count();
  let anyRunNowEnabled = false;
  for (let i = 0; i < runNowCount; i++) {
    if (await runNowButtons.nth(i).isEnabled()) anyRunNowEnabled = true;
  }
  check(
    "Run now stays enabled while paused (affordance only, not clicked)",
    runNowCount > 0 && anyRunNowEnabled,
    `buttons=${runNowCount}`,
  );

  // --- Re-enable ------------------------------------------------------------
  await page.getByRole("button", { name: "Status" }).first().click();
  const enabled = page.getByText("Enabled", { exact: true }).first();
  await enabled.waitFor({ timeout: 6000 });
  check("Status toggle re-enables the automation", true);
  await page.screenshot({ path: `${SHOTS}/05-reenabled.png` });

  // --- Other tabs still render (command-bus changes didn't break them) ------
  for (const tab of ["Tasks", "Notes", "Chats"]) {
    await page.getByRole("button", { name: tab }).first().click();
    await page.waitForTimeout(400);
  }
  const boardBack = page.locator('[aria-label="Add task"]').first();
  await page.getByRole("button", { name: "Tasks" }).first().click();
  await boardBack.waitFor({ timeout: 8000 });
  check("Tasks / Notes / Chats tabs still render", true);
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // --- Cleanup: soft-delete the scratch automation --------------------------
  try {
    await page.getByRole("button", { name: "Automations" }).first().click();
    const row = page.getByRole("button", { name: new RegExp(name) }).first();
    if (await row.count()) {
      await row.click();
      // The detail top-bar ··· trigger is always visible (the row's is hidden
      // until hover); it renders after the aside, so take the last match.
      await page
        .getByRole("button", { name: `Actions for ${name}` })
        .last()
        .click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await row.waitFor({ state: "detached", timeout: 8000 });
      check("delete removes the automation from the index", true);
    }
  } catch (e) {
    log(`cleanup note: ${String(e)}`);
  }
  await cleanup();
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.pass).length;
log(`\n${results.length - failed}/${results.length} checks passed.`);
log(`Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
