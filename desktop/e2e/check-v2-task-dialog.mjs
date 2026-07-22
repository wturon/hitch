// One-off check for V2 M2 PR 3: TaskDialogV2 capture + edit over the Hono
// server. DISPOSABLE, not a maintained test — see ../../AGENTS.md.
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010) and
// the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-task-dialog.mjs
//
// Drives: sign-up → seed backlog over the API → capture (`C` + the add-row,
// multiline body, ⌘⏎) asserting the task lands AT THE TOP with the seeded
// title and the body VERBATIM on the server (byte-compare) → draft recovery
// (type, esc, reopen restores; ⌘⏎ clears) → edit flow (title + body edits,
// esc = instant close + background flush, reopen shows server truth) → echo
// suppression (body dirty in the editor while an out-of-band PATCH renames
// the title: the title updates in the open dialog, the editor is untouched).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SERVER_URL = process.env.HITCH_SERVER_URL;
if (!SERVER_URL) {
  console.error("Set HITCH_SERVER_URL (e.g. http://localhost:3010) first.");
  process.exit(1);
}

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, "v2-task-dialog.log");
writeFileSync(LOG, "");

const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass = true, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const email = `e2e-dialog-${Date.now()}@example.com`;
const password = "hitch-e2e-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `fn` until it returns truthy or the deadline passes.
async function until(fn, { timeout = 10_000, step = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("until(): timed out");
    await sleep(step);
  }
}

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-task-dialog" });

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 240s, exiting");
  cleanup().finally(() => process.exit(2));
}, 240_000);

try {
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const dialog = () => page.locator('[data-slot="task-dialog-v2"]');
  const editor = () =>
    page.locator('[aria-label="Editor"][contenteditable="true"]');
  const titleInput = () => page.locator('[aria-label="Task title"]');
  const backlogRows = () =>
    page.locator("[data-testid=v2-backlog] [data-testid=v2-task-row]");
  const taskRow = (name) =>
    page.locator("[data-testid=v2-task-row]", { hasText: name });
  const backlogTitles = async () =>
    (await backlogRows().allInnerTexts()).map((t) => t.split("\n")[0]);

  // --- Boot: sign up, land in the auto-created Inbox ------------------------
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("E2E Dialog");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page
    .locator('[data-testid=v2-project-row][aria-current="true"]', { hasText: "Inbox" })
    .waitFor({ timeout: 30_000 });
  check("1. sign-up lands in the Inbox workspace");

  // Server API access via the key the app minted into the isolated secrets.
  const creds = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8")).hitchServer;
  const api = async (method, path, body) => {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  };

  const projects = await api("GET", "/projects");
  const inbox = projects.find((p) => p.name === "Inbox");
  // Two pre-existing backlog rows so the capture's prepend is observable.
  const existingOne = await api("POST", "/tasks", {
    projectId: inbox.id,
    title: "Existing one",
    body: "original body text",
    sortOrder: "a0",
  });
  const existingTwo = await api("POST", "/tasks", {
    projectId: inbox.id,
    title: "Existing two",
    body: "steady body",
    sortOrder: "a1",
  });
  await taskRow("Existing one").waitFor({ timeout: 10_000 });
  check("2. seeded 2 backlog tasks over the API (WS brings them in)");

  // --- Capture flow: `C` → multiline body → ⌘⏎ ------------------------------
  await page.keyboard.press("c");
  await dialog().waitFor({ timeout: 10_000 });
  const noTitleInCapture = (await titleInput().count()) === 0;
  check("3. `C` opens the capture card (chrome-free: no title input)", noTitleInCapture);
  await shot("v2-dialog-01-capture-open");

  const line1 = "Fix the flaky sync retry loop";
  const line2 = "It stalls when the daemon reconnects.";
  await editor().click();
  await page.keyboard.type(line1);
  await page.keyboard.press("Enter");
  await page.keyboard.type(line2);
  await shot("v2-dialog-02-capture-typed");
  await page.keyboard.press("Meta+Enter");

  // ⌘⏎ transforms in place: the saved-stage header (title input) appears with
  // the seed title — the body's first ~6 words, additive, never carved out.
  await titleInput().waitFor({ timeout: 10_000 });
  const seedTitle = await titleInput().inputValue();
  check(
    "4. ⌘⏎ transforms capture→saved with the seeded title",
    seedTitle === "Fix the flaky sync retry loop",
    `title="${seedTitle}"`,
  );
  await shot("v2-dialog-03-capture-saved");

  // The server row: body VERBATIM (two paragraphs → blank-line separated
  // markdown; the editor's canonical export terminates with a single trailing
  // "\n" — see editor/bridge/exportMarkdown.ts), sortOrder BEFORE the head.
  const created = await until(async () =>
    (await api("GET", `/tasks?project_id=${inbox.id}`)).find(
      (t) => t.title === "Fix the flaky sync retry loop",
    ),
  );
  const expectedBody = `${line1}\n\n${line2}\n`;
  check(
    "5. body lands on the server VERBATIM (byte-compare)",
    created.body === expectedBody,
    JSON.stringify(created.body),
  );
  check(
    "6. sortOrder prepends before the backlog head",
    created.sortOrder < "a0",
    `sortOrder="${created.sortOrder}"`,
  );
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 5_000 });
  const orderAfterCapture = await backlogTitles();
  check(
    "7. captured task renders at the TOP of the backlog",
    JSON.stringify(orderAfterCapture) ===
      JSON.stringify(["Fix the flaky sync retry loop", "Existing one", "Existing two"]),
    orderAfterCapture.join(" | "),
  );
  await shot("v2-dialog-04-list-after-capture");

  // --- Draft recovery: type, esc (instant), reopen restores, ⌘⏎ clears ------
  await page.locator("[data-testid=v2-add-task]").click();
  await dialog().waitFor({ timeout: 10_000 });
  check("8. the add-row affordance opens capture");
  await editor().click();
  await page.keyboard.type("half-formed thought");
  const tasksBefore = (await api("GET", `/tasks?project_id=${inbox.id}`)).length;
  const escStart = Date.now();
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3_000 });
  check("9. esc closes the capture instantly", true, `closed in ${Date.now() - escStart}ms`);
  const tasksAfterEsc = (await api("GET", `/tasks?project_id=${inbox.id}`)).length;
  check("10. esc-closed capture creates NO task", tasksAfterEsc === tasksBefore);

  await page.keyboard.press("c");
  await dialog().waitFor({ timeout: 10_000 });
  await sleep(400);
  const restored = (await editor().innerText()).trim();
  check(
    "11. reopening capture restores the localStorage draft",
    restored === "half-formed thought",
    `restored="${restored}"`,
  );
  await shot("v2-dialog-05-draft-restored");
  await page.keyboard.press("Meta+Enter");
  await titleInput().waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 5_000 });
  await page.keyboard.press("c");
  await dialog().waitFor({ timeout: 10_000 });
  await sleep(400);
  const cleared = (await editor().innerText()).trim();
  check(
    "12. a successful ⌘⏎ clears the draft (fresh capture opens empty)",
    cleared === "",
    `body="${cleared}"`,
  );
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3_000 });

  // --- Edit flow: row click → edit body + title → esc = close + flush -------
  await taskRow("Existing one").click();
  await dialog().waitFor({ timeout: 10_000 });
  await titleInput().waitFor({ timeout: 5_000 });
  const openedTitle = await titleInput().inputValue();
  const openedBody = (await editor().innerText()).trim();
  check(
    "13. row click opens the dialog on the live row (title + body)",
    openedTitle === "Existing one" && openedBody === "original body text",
    `title="${openedTitle}" body="${openedBody}"`,
  );
  // The editor auto-focuses at the end of the body on open — append there.
  await sleep(400);
  await page.keyboard.type(" plus edits");
  // Replace the title wholesale.
  await titleInput().click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Renamed by editor");
  await shot("v2-dialog-06-edited");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3_000 });
  // Esc is instant; the flush runs in the background — poll the server.
  const afterEdit = await until(async () => {
    const t = await api("GET", `/tasks/${existingOne.id}`);
    // Trailing "\n": the editor's canonical markdown export, stored verbatim.
    return t.title === "Renamed by editor" && t.body === "original body text plus edits\n"
      ? t
      : null;
  });
  check(
    "14. close flushes title + body to the server (background save-on-close)",
    Boolean(afterEdit),
  );
  // Reopen (via the renamed row — WS refreshed the list) → server truth.
  await taskRow("Renamed by editor").click();
  await dialog().waitFor({ timeout: 10_000 });
  const reTitle = await titleInput().inputValue();
  const reBody = (await editor().innerText()).trim();
  check(
    "15. reopening shows the saved content",
    reTitle === "Renamed by editor" && reBody === "original body text plus edits",
    `title="${reTitle}" body="${reBody}"`,
  );
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3_000 });

  // --- Echo suppression: dirty body + out-of-band title PATCH ---------------
  await taskRow("Existing two").click();
  await dialog().waitFor({ timeout: 10_000 });
  await sleep(400); // editor auto-focus at body end
  await page.keyboard.type(" typed-mid-flight");
  // While the body is dirty in the editor, rename the task out-of-band.
  await api("PATCH", `/tasks/${existingTwo.id}`, { title: "Retitled out-of-band" });
  // The clean title field adopts the external value INSIDE the open dialog...
  await until(async () => (await titleInput().inputValue()) === "Retitled out-of-band");
  check("16. out-of-band title PATCH updates the open dialog's title (clean field adopts)");
  // ...while the dirty body editor is untouched by the WS-driven refetch.
  const dirtyBody = (await editor().innerText()).trim();
  check(
    "17. the dirty body editor is NOT reset by the refetch (echo suppression)",
    dirtyBody === "steady body typed-mid-flight",
    `body="${dirtyBody}"`,
  );
  await shot("v2-dialog-07-echo-suppression");
  // The idle autosave then persists ONLY the body; the out-of-band title stays.
  const settled = await until(async () => {
    const t = await api("GET", `/tasks/${existingTwo.id}`);
    return t.title === "Retitled out-of-band" && t.body === "steady body typed-mid-flight\n"
      ? t
      : null;
  });
  check("18. autosave persists the body without clobbering the external title", Boolean(settled));
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 3_000 });
  await shot("v2-dialog-08-final-list");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-dialog-99-error.png") }).catch(() => {});
} finally {
  await cleanup();
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
