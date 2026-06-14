// DISPOSABLE check for inline image attachments (Path A). Drives the real app
// against the real Convex deployment and asserts the renderer upload path:
// pasting an image into the task editor uploads it, writes a standard
// `![](attachments/image-N.png)` reference into the body, and renders it inline
// via a resolved (signed) URL.
//
//   node desktop/e2e/check-image-attach.mjs
//
// NOT covered: the daemon download path (the e2e harness runs an empty config,
// so no daemon syncs) and the delete cascade's local-file removal — verify those
// against a real hitched project by hand.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { launchHitch } from "./harness.mjs";

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const SHOTS = "/tmp/hitch-e2e/shots";
mkdirSync(SHOTS, { recursive: true });
const LOG = "/tmp/hitch-e2e/img-run.log";
writeFileSync(LOG, "");

const title = `e2e-img-${Date.now()}`;
const results = [];
const log = (s) => {
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
};
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const { page, cleanup } = await launchHitch();
page.on("dialog", (d) => d.dismiss().catch(() => {}));

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 120s, exiting");
  cleanup().finally(() => process.exit(2));
}, 120000);

try {
  const addTask = page.locator('[aria-label="Add task"]').first();
  await addTask.waitFor({ timeout: 25000 });
  check("boots signed-in (board renders)", true);

  await addTask.click();
  const newInput = page.locator('input[aria-label="Task title"]');
  await newInput.fill(title);
  await newInput.press("Enter");
  const card = page.getByText(title, { exact: false }).first();
  await card.waitFor({ timeout: 10000 });
  check("creates a task", true);

  await card.click();
  const body = page.locator('.hitch-mdx-content[contenteditable="true"]');
  await body.waitFor({ timeout: 10000 });
  await body.click();

  // Synthesize a clipboard paste of a PNG onto the editor surface — the same
  // ingress a real screenshot paste uses (imageUploadHandler).
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "image.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector(
      '.hitch-mdx-content[contenteditable="true"]',
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, PNG_B64);

  // The image node only appears after the upload handler resolves (upload →
  // register → return the relative path). Give it a beat, then assert an <img>
  // is present and its resolved src is a Convex signed URL (preview handler).
  const img = body.locator("img").first();
  await img.waitFor({ timeout: 20000 });
  const src = await img.getAttribute("src");
  check(
    "pasted image renders inline via resolved URL",
    !!src && /^https?:\/\//.test(src),
    `src=${(src ?? "").slice(0, 60)}`,
  );
  await page.screenshot({ path: `${SHOTS}/img-01-inline.png` });

  // The body markdown must carry a standard relative reference.
  await page.locator('[aria-label="Task actions"]').click();
  await page.getByRole("menuitem", { name: "Raw markdown" }).click();
  const raw = page.locator('textarea[aria-label="Task content"]');
  await raw.waitFor({ timeout: 5000 });
  const rawVal = await raw.inputValue();
  check(
    "body contains ![](attachments/image-1.png)",
    /!\[[^\]]*\]\(attachments\/image-1\.png\)/.test(rawVal),
    `raw=${rawVal.replace(/\n/g, "\\n").slice(0, 120)}`,
  );
} catch (err) {
  check("run completed without throwing", false, String(err));
  await page.screenshot({ path: `${SHOTS}/img-99-error.png` }).catch(() => {});
} finally {
  try {
    // Reopen formatted (raw view has no actions menu delete? it does) then delete.
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
