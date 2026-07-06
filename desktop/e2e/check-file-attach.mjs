// DISPOSABLE check for Option A: arbitrary-file drag-drop + whole-dialog drop
// zone + hover affordance. Drives the real app against real Convex.
//
//   node desktop/e2e/check-file-attach.mjs
//
// Asserts: dragging a file over the dialog shows the "Drop files to attach"
// overlay; dropping a PDF appends a standard `[name](attachments/name)` link;
// dropping an image appends `![](attachments/image-N.png)` and renders inline.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = "/tmp/hitch-e2e/shots";
mkdirSync(SHOTS, { recursive: true });
const LOG = "/tmp/hitch-e2e/file-run.log";
writeFileSync(LOG, "");

const title = `e2e-file-${Date.now()}`;
const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// "%PDF-1.4\n%minimal" — content is irrelevant to the test, only the MIME type.
const PDF_B64 = "JVBERi0xLjQKJW1pbmltYWw=";

// Dispatch a synthetic drag event carrying a file onto the editor (a descendant
// of the dialog root, where our capture-phase listeners live).
function dragEventScript(eventType) {
  return ({ name, type, b64, ev }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target =
      document.querySelector('.hitch-editor-content') ??
      document.body;
    target.dispatchEvent(
      new DragEvent(ev, { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  };
}

const { page, cleanup } = await launchHitch();
page.on("dialog", (d) => d.dismiss().catch(() => {}));

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 120s, exiting");
  cleanup().finally(() => process.exit(2));
}, 120000);

const drag = (ev, file) =>
  page.evaluate(dragEventScript(ev), { ...file, ev });

try {
  // Capture a scratch todo (body-only), then ⌘⏎ crystallizes it into the saved
  // stage where the editor + ⋯ menu live.
  const addTodo = page.getByRole("button", { name: "Add a todo…" }).first();
  await addTodo.waitFor({ timeout: 25000 });
  await addTodo.click();
  const body = page.locator(".hitch-editor-content").first();
  await body.waitFor({ timeout: 10000 });
  await body.click();
  await page.keyboard.type(title);
  await page.keyboard.press("Meta+Enter");
  await page
    .locator('input[aria-label="Todo title"]')
    .waitFor({ timeout: 10000 });
  check("opens todo dialog", true);

  // --- Hover affordance -----------------------------------------------------
  await drag("dragenter", { name: "report.pdf", type: "application/pdf", b64: PDF_B64 });
  const overlay = page.getByText("Drop files to attach");
  await overlay.waitFor({ timeout: 4000 });
  check("drag-over shows 'Drop files to attach' overlay", true);
  await page.screenshot({ path: `${SHOTS}/file-01-overlay.png` });

  // --- Drop a PDF → standard markdown link ----------------------------------
  await drag("drop", { name: "report.pdf", type: "application/pdf", b64: PDF_B64 });
  // Overlay should clear after drop.
  await overlay.waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
  // Wait for the link reference to land in the body markdown.
  await page.locator('[aria-label="Todo actions"]').click();
  await page.getByRole("menuitem", { name: "Raw markdown" }).click();
  const raw = page.locator('textarea[aria-label="Todo content"]');
  await raw.waitFor({ timeout: 5000 });
  await page
    .waitForFunction(
      () =>
        /\[report\.pdf\]\(attachments\/report\.pdf\)/.test(
          document.querySelector('textarea[aria-label="Todo content"]')?.value ??
            "",
        ),
      { timeout: 20000 },
    )
    .then(() => check("dropped PDF → [report.pdf](attachments/report.pdf)", true))
    .catch(async () =>
      check(
        "dropped PDF → [report.pdf](attachments/report.pdf)",
        false,
        `raw=${(await raw.inputValue()).replace(/\n/g, "\\n").slice(0, 160)}`,
      ),
    );

  // --- Drop an image → inline image markdown --------------------------------
  await page.locator('[aria-label="Todo actions"]').click();
  await page.getByRole("menuitem", { name: "Formatted view" }).click();
  await body.waitFor({ timeout: 5000 });
  await drag("drop", { name: "shot.png", type: "image/png", b64: PNG_B64 });
  const img = body.locator("img").first();
  await img.waitFor({ timeout: 20000 });
  const src = await img.getAttribute("src");
  check(
    "dropped image renders inline via resolved URL",
    !!src && /^https?:\/\//.test(src),
    `src=${(src ?? "").slice(0, 50)}`,
  );
  await page.screenshot({ path: `${SHOTS}/file-02-after-drops.png` });
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/file-99-error.png` }).catch(() => {});
} finally {
  try {
    const actions = page.locator('[aria-label="Todo actions"]');
    if (await actions.count()) {
      await actions.click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
    }
  } catch {
    /* clearly named scratch task */
  }
  await cleanup();
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.pass).length;
log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
