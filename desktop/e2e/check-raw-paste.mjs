// DISPOSABLE check: clipboard paste of files works in the RAW markdown view
// (parity with the formatted view), inserting at the textarea caret. Drives the
// real app against real Convex.
//
//   node desktop/e2e/check-raw-paste.mjs

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const LOG = "/tmp/hitch-e2e/raw-paste-run.log";
mkdirSync("/tmp/hitch-e2e", { recursive: true });
writeFileSync(LOG, "");
const title = `e2e-rawpaste-${Date.now()}`;
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
const PDF_B64 = "JVBERi0xLjQKJW1pbmltYWw=";

function pasteScript({ name, type, b64 }) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], name, { type });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea[aria-label="Task content"]');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const { page, cleanup } = await launchHitch();
page.on("dialog", (d) => d.dismiss().catch(() => {}));
const watchdog = setTimeout(() => {
  log("WATCHDOG: exceeded 120s");
  cleanup().finally(() => process.exit(2));
}, 120000);

const rawHas = (re) =>
  page.waitForFunction(
    (src) =>
      new RegExp(src).test(
        document.querySelector('textarea[aria-label="Task content"]')?.value ??
          "",
      ),
    re,
    { timeout: 20000 },
  );

try {
  const addTask = page.locator('[aria-label="Add task"]').first();
  await addTask.waitFor({ timeout: 25000 });
  await addTask.click();
  const newInput = page.locator('input[aria-label="Task title"]');
  await newInput.fill(title);
  await newInput.press("Enter");
  const card = page.getByText(title, { exact: false }).first();
  await card.waitFor({ timeout: 10000 });
  await card.click();
  await page.locator('.hitch-mdx-content[contenteditable="true"]').waitFor({
    timeout: 10000,
  });

  // Switch to raw markdown view.
  await page.locator('[aria-label="Task actions"]').click();
  await page.getByRole("menuitem", { name: "Raw markdown" }).click();
  await page.locator('textarea[aria-label="Task content"]').waitFor({
    timeout: 5000,
  });
  check("raw view open", true);

  // Paste a PDF → standard link.
  await page.evaluate(pasteScript, {
    name: "report.pdf",
    type: "application/pdf",
    b64: PDF_B64,
  });
  await rawHas("\\[report\\.pdf\\]\\(attachments/report\\.pdf\\)")
    .then(() => check("raw paste of PDF → [report.pdf](attachments/report.pdf)", true))
    .catch(async () =>
      check(
        "raw paste of PDF → [report.pdf](attachments/report.pdf)",
        false,
        `raw=${(await page.locator('textarea[aria-label="Task content"]').inputValue()).replace(/\n/g, "\\n").slice(0, 160)}`,
      ),
    );

  // Paste an image → inline image markdown (image-N name).
  await page.evaluate(pasteScript, {
    name: "image.png",
    type: "image/png",
    b64: PNG_B64,
  });
  await rawHas("!\\[\\]\\(attachments/image-1\\.png\\)")
    .then(() => check("raw paste of image → ![](attachments/image-1.png)", true))
    .catch(async () =>
      check(
        "raw paste of image → ![](attachments/image-1.png)",
        false,
        `raw=${(await page.locator('textarea[aria-label="Task content"]').inputValue()).replace(/\n/g, "\\n").slice(0, 200)}`,
      ),
    );
} catch (err) {
  check("run completed without throwing", false, String(err));
} finally {
  try {
    const actions = page.locator('[aria-label="Task actions"]');
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
