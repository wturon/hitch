// One-off check for V2 M2 PR 6: attachments via presigned URLs — capture-stage
// image paste (materialize-early → renderer-direct presigned PUT → finalize →
// relative `attachments/<name>` ref in the body → inline render), ⌘⏎
// idempotence over the materialized row, saved-stage PDF drop (plain link +
// ⌘-click download via presigned GET), reload re-presign, esc-discard of a
// materialized capture, and the task-delete CASCADE over attachment rows.
// DISPOSABLE, not a maintained test — see ../../AGENTS.md.
//
// Prereqs: the compose stack is up (docker compose up -d --build, :3010 +
// Garage :3900) and the Vite dev renderer is running (:5173). Run with:
//
//   HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-attachments.mjs

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
const LOG = join(SHOTS, "v2-attachments.log");
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

const email = `e2e-${Date.now()}@example.com`;
const password = "hitch-e2e-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// "%PDF-1.4\n%minimal" — content is irrelevant, only the MIME type + bytes.
const PDF_B64 = "JVBERi0xLjQKJW1pbmltYWw=";
const b64Bytes = (b64) => Buffer.from(b64, "base64");

const { page, stateDir, cleanup } = await launchHitch({ profile: "v2-attachments" });

const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 300s, exiting");
  cleanup().finally(() => process.exit(2));
}, 300_000);

// Synthesize a clipboard paste of a file onto the editor surface (the same
// ingress a real screenshot paste uses).
const pasteFile = ({ name, type, b64 }) =>
  page.evaluate(
    ({ name, type, b64 }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector(".hitch-editor-content").dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { name, type, b64 },
  );

// Synthesize a file drop onto the editor surface (dialog-level listener).
const dropFile = ({ name, type, b64 }) =>
  page.evaluate(
    ({ name, type, b64 }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.querySelector(".hitch-editor-content").dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    },
    { name, type, b64 },
  );

try {
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const projectRow = (name) =>
    page.locator("[data-testid=v2-project-row]", { hasText: name });
  const taskRow = (name) =>
    page.locator("[data-testid=v2-task-row]", { hasText: name });
  const dialog = page.locator('[data-slot="task-dialog-v2"]');
  const editor = page.locator(".hitch-editor-content").first();
  const titleInput = dialog.locator('input[aria-label="Task title"]');
  // Escape until the dialog detaches: when the caret sits in a link (⌘-click,
  // or focusEnd landing after the body's trailing link) the LinkPopover is
  // open and the first Escape closes IT — same layering as V1.
  const closeDialog = async () => {
    for (let i = 0; i < 4 && (await dialog.count()) > 0; i++) {
      await page.keyboard.press("Escape");
      await sleep(400);
    }
    await dialog.waitFor({ state: "detached", timeout: 5_000 });
  };

  // --- Sign up, land in the workspace --------------------------------------
  await page.getByRole("heading", { name: "Sign in to Hitch" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByPlaceholder("Name").fill("E2E User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await projectRow("Inbox").waitFor({ timeout: 30_000 });
  check("1. sign-up lands in the workspace");

  const secrets = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  const creds = secrets.hitchServer;
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
  const apiStatus = async (method, path) => {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { "x-api-key": creds.apiKey },
    });
    return response.status;
  };

  // --- Seed: a Work project ------------------------------------------------
  const work = await api("POST", "/projects", { name: "Work", sortOrder: "m" });
  await projectRow("Work").waitFor({ timeout: 10_000 });
  await projectRow("Work").click();
  await page.locator("[data-testid=v2-add-task]").waitFor({ timeout: 10_000 });

  // --- CAPTURE-STAGE image paste: materialize-early + upload + inline ------
  await page.locator("[data-testid=v2-add-task]").click();
  await editor.waitFor({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.type("Attachment test task");
  await pasteFile({ name: "clipboard.png", type: "image/png", b64: PNG_B64 });

  // The image renders once materialize → upload → finalize → append resolves.
  const img = editor.locator("img").first();
  await img.waitFor({ timeout: 20_000 });
  const capSrc = await img.getAttribute("src");
  check(
    "2. capture-stage paste renders inline via a resolved presigned URL",
    !!capSrc && /^https?:\/\//.test(capSrc),
    `src=${(capSrc ?? "").slice(0, 60)}`,
  );
  check(
    "3. still in the capture stage (no title chrome — materialize-early is silent)",
    (await titleInput.count()) === 0,
  );
  await shot("v2-att-01-capture-paste");

  // Server truth: exactly one provisional row, one finalized attachment.
  const tasksAfterPaste = await api("GET", `/tasks?project_id=${work.id}`);
  check(
    "4. paste materialized exactly one provisional task row",
    tasksAfterPaste.length === 1,
    `tasks=${tasksAfterPaste.length}`,
  );
  const taskId = tasksAfterPaste[0]?.id;
  const attsAfterPaste = await api("GET", `/attachments?task_id=${taskId}`);
  check(
    "5. server: one attachment row, finalized, verbatim filename image-1.png",
    attsAfterPaste.length === 1 &&
      attsAfterPaste[0].state === "finalized" &&
      attsAfterPaste[0].filename === "image-1.png",
    JSON.stringify(attsAfterPaste.map((a) => [a.filename, a.state])),
  );
  const imgAttId = attsAfterPaste[0]?.id;
  const dl1 = await api("GET", `/attachments/${imgAttId}/download`);
  const obj1 = await fetch(dl1.url);
  const obj1Bytes = Buffer.from(await obj1.arrayBuffer());
  check(
    "6. presigned GET serves the exact uploaded bytes",
    obj1.ok && obj1Bytes.equals(b64Bytes(PNG_B64)),
    `status=${obj1.status} len=${obj1Bytes.length}`,
  );

  // --- ⌘⏎: idempotent over the materialized row ----------------------------
  await page.keyboard.press("Meta+Enter");
  await titleInput.waitFor({ timeout: 10_000 });
  await sleep(800);
  const tasksAfterCommit = await api("GET", `/tasks?project_id=${work.id}`);
  const committed = tasksAfterCommit.find((t) => t.id === taskId);
  check(
    "7. ⌘⏎ PATCHed the SAME row (no second task) with the seed title",
    tasksAfterCommit.length === 1 && committed?.title === "Attachment test task",
    `tasks=${tasksAfterCommit.length} title=${committed?.title}`,
  );
  check(
    "8. body keeps the RELATIVE ref, verbatim — never a presigned URL",
    /!\[\]\(attachments\/image-1\.png\)/.test(committed?.body ?? "") &&
      !/https?:\/\//.test(committed?.body ?? ""),
    `body=${JSON.stringify(committed?.body).slice(0, 120)}`,
  );

  // --- SAVED-STAGE PDF drop: plain link + autosaved ref --------------------
  await dropFile({ name: "Quarterly Report.pdf", type: "application/pdf", b64: PDF_B64 });
  const pdfLink = dialog.locator("a", { hasText: "quarterly-report.pdf" });
  await pdfLink.waitFor({ timeout: 20_000 });
  check("9. dropped PDF appends a plain link (kebab-sanitized name)");
  await shot("v2-att-02-pdf-link");
  await sleep(2_500); // let the ~1.5s idle autosave PATCH the body
  const attsAfterDrop = await api("GET", `/attachments?task_id=${taskId}`);
  const pdfRow = attsAfterDrop.find((a) => a.filename === "quarterly-report.pdf");
  check(
    "10. server: PDF row finalized alongside the image",
    attsAfterDrop.length === 2 && pdfRow?.state === "finalized",
    JSON.stringify(attsAfterDrop.map((a) => [a.filename, a.state])),
  );
  const bodyAfterDrop = (await api("GET", `/tasks/${taskId}`)).body;
  check(
    "11. autosaved body carries [quarterly-report.pdf](attachments/quarterly-report.pdf)",
    /\[quarterly-report\.pdf\]\(attachments\/quarterly-report\.pdf\)/.test(bodyAfterDrop),
    `body=${JSON.stringify(bodyAfterDrop).slice(0, 160)}`,
  );

  // --- ⌘-click the link → presigned GET download ---------------------------
  // Stub window.open so the presigned URL is captured instead of handed to
  // shell.openExternal (which would pop a real browser mid-run).
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await pdfLink.click({ modifiers: ["Meta"] });
  await page.waitForFunction(() => window.__opened.length > 0, { timeout: 10_000 });
  const openedUrl = (await page.evaluate(() => window.__opened))[0];
  const dlRes = await fetch(openedUrl);
  const dlBytes = Buffer.from(await dlRes.arrayBuffer());
  check(
    "12. ⌘-click resolves the relative ref to a presigned GET that serves the PDF bytes",
    /^https?:\/\//.test(openedUrl) && dlRes.ok && dlBytes.equals(b64Bytes(PDF_B64)),
    `url=${openedUrl.slice(0, 60)} status=${dlRes.status}`,
  );

  // --- Reload → fresh presign ----------------------------------------------
  await closeDialog();
  await page.reload();
  await taskRow("Attachment test task").waitFor({ timeout: 30_000 });
  await taskRow("Attachment test task").click();
  const img2 = editor.locator("img").first();
  await img2.waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".hitch-editor-content img");
      return el && el.complete && el.naturalWidth > 0;
    },
    { timeout: 20_000 },
  );
  const src2 = await img2.getAttribute("src");
  check(
    "13. after reload the image renders again via a FRESH presigned URL",
    !!src2 && /^https?:\/\//.test(src2),
    `src=${(src2 ?? "").slice(0, 60)}`,
  );
  await shot("v2-att-03-after-reload");
  await closeDialog();

  // --- Esc discards a materialized capture (row + CASCADE) -----------------
  await page.locator("[data-testid=v2-add-task]").click();
  await editor.waitFor({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.type("Discard me");
  await pasteFile({ name: "clipboard.png", type: "image/png", b64: PNG_B64 });
  await editor.locator("img").first().waitFor({ timeout: 20_000 });
  const tasksMidCapture = await api("GET", `/tasks?project_id=${work.id}`);
  const provisional = tasksMidCapture.find((t) => t.id !== taskId);
  check(
    "14. second capture's paste materialized a provisional row",
    tasksMidCapture.length === 2 && provisional !== undefined,
    `tasks=${tasksMidCapture.length}`,
  );
  const provisionalAtts = await api("GET", `/attachments?task_id=${provisional.id}`);
  await closeDialog();
  await sleep(800);
  const tasksAfterDiscard = await api("GET", `/tasks?project_id=${work.id}`);
  check(
    "15. esc deleted the provisional row (capture discard, V1 Decision 3)",
    tasksAfterDiscard.length === 1 && tasksAfterDiscard[0].id === taskId,
    `tasks=${tasksAfterDiscard.length}`,
  );
  check(
    "16. its attachment rows rode the CASCADE (download now 404s)",
    provisionalAtts.length === 1 &&
      (await apiStatus("GET", `/attachments/${provisionalAtts[0].id}/download`)) === 404,
  );

  // --- Task delete → attachment rows CASCADE -------------------------------
  await api("DELETE", `/tasks/${taskId}`);
  check(
    "17. deleting the task cascades its attachment rows (both downloads 404)",
    (await apiStatus("GET", `/attachments/${imgAttId}/download`)) === 404 &&
      (await apiStatus("GET", `/attachments/${pdfRow.id}/download`)) === 404,
  );
  await shot("v2-att-04-final");
} catch (error) {
  check("run completed without throwing", false, String(error));
  await page.screenshot({ path: join(SHOTS, "v2-att-99-error.png") }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
log(failed === 0 ? `${results.length}/${results.length} checks passed.` : `==== ${failed} CHECK(S) FAILED ====`);
process.exit(failed === 0 ? 0 : 1);
