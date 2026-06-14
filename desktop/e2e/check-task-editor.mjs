// One-off check for the task-editor refactor (useTaskDraft + controlled
// MarkdownEditor). Drives the real app and asserts the behaviors most at risk.
// This is a DISPOSABLE example, not a maintained test — see ../../AGENTS.md.
//
//   node desktop/e2e/check-task-editor.mjs
//
// It creates a clearly-named scratch task, exercises the editor, then deletes
// it. Confine all edits to that scratch task.
//
// NOT covered here: external-edit adoption (an outside writer changing the open
// task in Convex). That needs the task's projectId, which isn't exposed to a
// script — verify it by hand, or wire a Convex client as a follow-up.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchHitch } from "./harness.mjs";

// A late teardown race in Playwright/Electron can reject after our checks are
// done; don't let it crash the run summary.
process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = "/tmp/hitch-e2e/shots";
mkdirSync(SHOTS, { recursive: true });
// Also append results to a file as they happen — background stdout is buffered,
// so this lets you read progress mid-run.
const LOG = "/tmp/hitch-e2e/run.log";
writeFileSync(LOG, "");

const title = `e2e-scratch-${Date.now()}`;
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

// Last-resort watchdog so a stuck selector can never hang the run forever.
const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 120s, exiting");
  cleanup().finally(() => process.exit(2));
}, 120000);

try {
  // --- Boot signed-in -------------------------------------------------------
  const addTask = page.locator('[aria-label="Add task"]').first();
  await addTask.waitFor({ timeout: 25000 });
  await page.screenshot({ path: `${SHOTS}/01-board.png` });
  check("boots signed-in (board renders)", true);

  // --- Create a scratch task ------------------------------------------------
  await addTask.click();
  const newInput = page.locator('input[aria-label="Task title"]');
  await newInput.fill(title);
  await newInput.press("Enter");
  const card = page.getByText(title, { exact: false }).first();
  await card.waitFor({ timeout: 10000 });
  check("creates a task", true);

  // --- Open the dialog ------------------------------------------------------
  await card.click();
  // The editable div; a sibling placeholder div shares the class, so filter on
  // contenteditable to get the real editor.
  const body = page.locator('.hitch-mdx-content[contenteditable="true"]');
  await body.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/02-dialog.png` });

  // --- Caret does NOT reset on own edits (the controlled-editor regression) --
  // Type in two bursts; if MarkdownEditor wrongly re-ran setMarkdown between
  // them, the caret would jump to the start and we'd get "BBBAAA".
  await body.click();
  await page.keyboard.type("AAA");
  await page.keyboard.type("BBB");
  const bodyText = (await body.innerText()).trim();
  check(
    "caret stays put across keystrokes",
    bodyText === "AAABBB",
    `body="${bodyText}"`,
  );

  // --- Title spacebar (untrimmed rawTitle) ----------------------------------
  // Append a trailing space to the existing (unique) title; the display/card
  // trims it, so this stays non-destructive and the card is still findable.
  const titleBox = page.locator('textarea[aria-label="Task title"]');
  await titleBox.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ");
  const titleVal = await titleBox.inputValue();
  check(
    "trailing space in title is preserved",
    titleVal === `${title} `,
    `title="${titleVal}"`,
  );

  // --- Enter in title moves focus to the body -------------------------------
  await titleBox.click();
  await titleBox.press("Enter");
  const bodyFocused = await page.evaluate(
    () => document.activeElement?.classList.contains("hitch-mdx-content") ?? false,
  );
  check("Enter in title focuses the body", bodyFocused);

  // --- Raw ⇄ formatted round-trip -------------------------------------------
  await page.locator('[aria-label="Task actions"]').click();
  await page.getByRole("menuitem", { name: "Raw markdown" }).click();
  const raw = page.locator('textarea[aria-label="Task content"]');
  await raw.waitFor({ timeout: 5000 });
  const rawVal = await raw.inputValue();
  check(
    "raw view shows frontmatter + body",
    rawVal.includes("AAABBB") && rawVal.includes(`title: ${title}`),
    `raw startsWith="${rawVal.slice(0, 40).replace(/\n/g, "\\n")}"`,
  );
  await page.locator('[aria-label="Task actions"]').click();
  await page.getByRole("menuitem", { name: "Formatted view" }).click();
  await body.waitFor({ timeout: 5000 });

  // --- Close saves; reopen shows the same body ------------------------------
  await page.locator('[aria-label="Close"]').click();
  await body.waitFor({ state: "detached", timeout: 8000 });
  const reopened = page.getByText(title, { exact: false }).first();
  await reopened.waitFor({ timeout: 10000 });
  await reopened.click();
  await body.waitFor({ timeout: 10000 });
  const persisted = (await body.innerText()).trim();
  check(
    "close saves; reopen restores body",
    persisted === "AAABBB",
    `body="${persisted}"`,
  );
  await page.screenshot({ path: `${SHOTS}/03-reopened.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // --- Best-effort cleanup: delete the scratch task -------------------------
  try {
    const actions = page.locator('[aria-label="Task actions"]');
    if (await actions.count()) {
      await actions.click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
    }
  } catch {
    /* leave it; it's clearly named */
  }
  await cleanup();
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.pass).length;
log(`\n${results.length - failed}/${results.length} checks passed.`);
log(`Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
