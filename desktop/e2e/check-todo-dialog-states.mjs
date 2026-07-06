// One-off check for Todos v1 slice 5: the existing-todo TodoDialog states +
// detach + uncheck→backlog-top. DISPOSABLE, not a maintained test — see
// ../../AGENTS.md → "Verifying UI changes".
//
//   HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 \
//     node desktop/e2e/check-todo-dialog-states.mjs
//
// It creates ONE clearly-named scratch task in the active project, opens it in
// the TodoDialog (saved stage), drives its footer through the slice-5 states by
// editing the raw frontmatter (requested / failed / linked), then exercises the
// list-level gestures (detach→backlog, check→uncheck→top, archive→removed).
// Everything is confined to that scratch task, which is deleted at the end.
//
// The footer states are driven by writing frontmatter into the dialog's raw view
// (the daemon is idle in the isolated instance, so we can't get a real chat to
// bind — we assert the UI reacts to the frontmatter the daemon would project).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "todo-dialog-states.log");
writeFileSync(LOG, "");

const title = `e2e-slice5-${Date.now()}`;
const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Build the full task.md content the raw view expects (frontmatter + body).
const fm = (keys, body = "the scratch body") =>
  ["---", `title: ${title}`, ...keys, "---", body, ""].join("\n");

const { page, cleanup } = await launchHitch();
page.on("dialog", (d) => d.dismiss().catch(() => {}));

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 150s, exiting");
  cleanup().finally(() => process.exit(2));
}, 150000);

// Set the dialog's raw content, then wait for the footer to react.
async function setRaw(keys) {
  const raw = page.locator('textarea[aria-label="Todo content"]');
  await raw.waitFor({ timeout: 8000 });
  await raw.fill(fm(keys));
  await page.waitForTimeout(300);
}
async function openRawView() {
  await page.locator('[aria-label="Todo actions"]').click();
  await page.getByRole("menuitem", { name: "Raw markdown" }).click();
}

try {
  // --- Boot signed-in, go to the Todos tab --------------------------------
  await page.getByRole("button", { name: "Todos" }).first().waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Todos" }).first().click();
  const addRow = page.getByRole("button", { name: "Add a todo…" });
  await addRow.waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/00-todos.png` });
  check("boots + Todos tab renders", true);

  // --- Create a scratch todo via the capture card -------------------------
  await addRow.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/00b-capture.png` });
  const captureBody = page.locator('[aria-label="Editor"][contenteditable="true"]');
  await captureBody.waitFor({ timeout: 20000 });
  await captureBody.click();
  await page.keyboard.type(title);
  await page.keyboard.press("Meta+Enter"); // capture → saved
  // The saved stage shows the compose footer's Start button.
  await page
    .locator('[aria-label="Start"]')
    .waitFor({ timeout: 10000 });
  check("capture ⌘⏎ transforms to the saved stage (compose footer)", true);
  // Close so the row lands in BACKLOG.
  await page.locator('[aria-label="Close"]').click();
  const row = page.getByText(title, { exact: false }).first();
  await row.waitFor({ timeout: 10000 });
  check("saved todo appears in the list", true);

  // --- Deliverable 1: a row opens the TodoDialog in the SAVED stage --------
  await row.click();
  const titleBox = page.locator('input[aria-label="Todo title"]');
  await titleBox.waitFor({ timeout: 10000 });
  const openedTitle = await titleBox.inputValue();
  check(
    "row opens TodoDialog in saved stage (title populated)",
    openedTitle.trim() === title,
    `title="${openedTitle}"`,
  );

  // --- Footer state: REQUESTED --------------------------------------------
  await openRawView();
  await setRaw(["chat-request: requested", "chat-request-harness: claude-code"]);
  const requested =
    (await page.getByText("Requested", { exact: true }).count()) > 0 &&
    (await page.getByText("Cancel request").count()) > 0;
  check("requested frontmatter → Requested footer + Cancel request", requested);
  await page.screenshot({ path: `${SHOTS}/01-requested.png` });

  // --- Footer state: FAILED -----------------------------------------------
  await setRaw([
    "chat-request: failed",
    "chat-request-harness: claude-code",
    "chat-request-error: exited before binding",
  ]);
  const failed =
    (await page.getByText("Failed to start").count()) > 0 &&
    (await page.getByText("Retry", { exact: true }).count()) > 0 &&
    (await page.getByText("exited before binding").count()) > 0;
  check("failed frontmatter → Failed to start footer + Retry", failed);
  await page.screenshot({ path: `${SHOTS}/02-failed.png` });

  // --- Footer state: LINKED -----------------------------------------------
  await setRaw([
    "chat-harness: claude-code",
    "chat-id: e2e-sess-1",
    "chat-status: working",
  ]);
  const linked =
    (await page.getByText("Open chat").count()) > 0 &&
    (await page.getByText("Working…").count()) > 0;
  check("linked frontmatter → linked footer (Open chat + Working…)", linked);
  await page.screenshot({ path: `${SHOTS}/03-linked.png` });

  // --- Detach chat → derives back to BACKLOG ------------------------------
  // Detach persists cleared content; reopen shows the compose footer (no chat,
  // no request → backlog).
  await page.locator('[aria-label="Todo actions"]').click();
  await page.getByRole("menuitem", { name: "Detach chat" }).click();
  await page.waitForTimeout(400);
  // The footer should now be compose again (Start button back).
  const detached = (await page.locator('[aria-label="Start"]').count()) > 0;
  check("Detach chat → compose footer (todo back in backlog)", detached);
  await page.locator('[aria-label="Close"]').click();
  await titleBox.waitFor({ state: "detached", timeout: 8000 });

  // --- Check → DONE, then Uncheck → top of BACKLOG ------------------------
  const rowAfter = page.getByText(title, { exact: false }).first();
  await rowAfter.waitFor({ timeout: 10000 });
  // The checkbox lives in the same row; scope to the row's container.
  const rowContainer = rowAfter.locator(
    'xpath=ancestor::*[@role="button"][1]',
  );
  await rowContainer.getByRole("checkbox").click(); // → DONE
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/04-checked.png` });
  // Uncheck from DONE (may need to expand — it's within the preview slice).
  const doneRow = page.getByText(title, { exact: false }).first();
  const doneContainer = doneRow.locator(
    'xpath=ancestor::*[@role="button"][1]',
  );
  await doneContainer.getByRole("checkbox").click(); // → back to BACKLOG top
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/05-unchecked.png` });
  // Assert it's the FIRST row under the BACKLOG header. The list renders the
  // BACKLOG GroupHeader, an "Add a todo…" row, then the ordered rows; the
  // unchecked task should be the first real todo row after the add-row.
  const firstBacklog = await page.evaluate((t) => {
    const heads = [...document.querySelectorAll("span")].filter(
      (s) => s.textContent?.trim() === "BACKLOG",
    );
    if (!heads.length) return null;
    // Walk forward from the BACKLOG section to the first row with a title.
    const section = heads[0].closest("section");
    if (!section) return null;
    const rows = [...section.querySelectorAll('[role="button"]')];
    const withTitle = rows.find((r) => r.textContent?.includes(t) || true);
    return rows.length ? rows[0]?.textContent ?? null : withTitle ? "?" : null;
  }, title);
  check(
    "uncheck lands the todo at the TOP of BACKLOG",
    typeof firstBacklog === "string" && firstBacklog.includes(title),
    `firstBacklogRow="${(firstBacklog ?? "").slice(0, 60)}"`,
  );

  // --- Archive → removed from ALL groups ----------------------------------
  const rowForArchive = page.getByText(title, { exact: false }).first();
  await rowForArchive.click();
  // The dialog reopens in whichever view was last used (raw, from the footer
  // tests), so wait for the always-present ⋯ actions button, not the title box.
  await page.locator('[aria-label="Todo actions"]').waitFor({ timeout: 10000 });
  await page.locator('[aria-label="Todo actions"]').click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.waitForTimeout(600);
  const stillListed = await page.getByText(title, { exact: false }).count();
  check(
    "Archive removes the todo from every group (archived-at, not status:)",
    stillListed === 0,
    `remaining=${stillListed}`,
  );
  await page.screenshot({ path: `${SHOTS}/06-archived.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/99-error.png` }).catch(() => {});
} finally {
  // --- Best-effort cleanup: delete the scratch todo -----------------------
  // It's archived (archived-at), so it's out of the four Todos groups but
  // reachable from the Todos view's Archived sheet. Delete it there, scoped to
  // the scratch title so a real archived todo is never touched.
  try {
    // Dismiss any open dialog/backdrop so the header click isn't intercepted.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    const archivedBtn = page.getByRole("button", { name: "Archived" }).first();
    if (await archivedBtn.count()) {
      await archivedBtn.click();
      await page.waitForTimeout(400);
      // The ArchivedRow div carries the title text and its own Delete button.
      const row = page
        .locator("div")
        .filter({ hasText: title })
        .filter({ has: page.getByRole("button", { name: "Delete" }) })
        .last();
      if (await row.count()) {
        await row.getByRole("button", { name: "Delete" }).click();
        log("cleanup: deleted scratch todo via Archived sheet");
      } else {
        log("cleanup: scratch todo not found in Archived sheet (may already be gone)");
      }
    } else {
      log("cleanup: Archived control unavailable");
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
