// Throwaway end-to-end proof for Snippets v1 (feat/snippets-v1) — all three
// surfaces against the real app + dev Convex:
//   A. TodoDialog: select text → floating-toolbar "Save snippet" → name → Saved
//      (real Convex create), then `/name` → Snippets section → Enter inserts
//      the BODY (no /reference left), then Escape discards the capture.
//   B. Global settings → Snippets tab: the created row is listed; Delete removes
//      it (cleanup doubles as the CRUD check).
//   C. Editor Sandbox (component mode, SAMPLE_SNIPPETS): multi-block snippet
//      body (`review-checklist`, heading + list) inserts as blocks.
//
// Run: npx vite --host 127.0.0.1 --port 5199   # this worktree, another shell
//      HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 node e2e/check-snippets.mjs
import { launchHitch } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(shots, name) }).catch(() => {});
const log = (...a) => console.log(...a);
process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const { page, cleanup } = await launchHitch({ profile: "snippets-check" });
page.on("dialog", (d) => d.dismiss().catch(() => {}));
let failures = 0;
const check = (label, ok, extra = "") => {
  log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

const editorText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".hitch-editor-content");
    return el ? el.textContent ?? "" : "";
  });

const SNIP_NAME = `e2e-snip-${Date.now()}`;
const SNIP_BODY = "The five boxing wizards jump quickly tonight";

try {
  await page.waitForTimeout(2500);
  await shot(page, "snip-00-boot.png");

  // ==== A. Save from selection + insert via `/`, inside the TodoDialog ====
  const addTodo = page.getByRole("button", { name: "Add a todo…" }).first();
  await addTodo.waitFor({ timeout: 25000 });
  await addTodo.click();
  const editor = page.locator(".hitch-editor-content");
  await editor.first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(200);

  await editor.first().click();
  await page.keyboard.type(SNIP_BODY);
  await page.waitForTimeout(150);
  await page.keyboard.press("Meta+a");
  await page.waitForTimeout(400);
  await shot(page, "snip-01-selection.png");

  const saveBtn = page.getByRole("button", { name: "Save snippet" });
  check("floating toolbar shows Save snippet on selection", (await saveBtn.count()) > 0);
  await saveBtn.click();
  const nameInput = page.getByLabel("Snippet name");
  await nameInput.waitFor({ timeout: 5000 });
  await shot(page, "snip-02-name-form.png");
  await nameInput.fill(SNIP_NAME);
  await page.keyboard.press("Enter");
  const savedFlash = page.getByRole("status").filter({ hasText: "Saved" });
  await savedFlash.waitFor({ timeout: 10000 });
  check("Saved flash appears after Enter (Convex create succeeded)", true);
  await shot(page, "snip-03-saved-flash.png");
  await page.waitForTimeout(1400); // let the flash resolve back to rest

  // The flash restores the original (whole-doc) selection by design — collapse
  // it before typing, or the next keystroke replaces the document.
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);

  // New line, then insert the snippet we just saved via the slash menu.
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(`/${SNIP_NAME}`);
  await page.waitForTimeout(600); // live query round-trip + filter
  await shot(page, "snip-04-slash-menu.png");
  check(
    "Snippets section header renders",
    (await page.getByText("Snippets", { exact: true }).count()) > 0,
  );
  check(
    "the saved snippet's row is offered",
    (await page.getByText(SNIP_NAME, { exact: true }).count()) > 0,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await shot(page, "snip-05-inserted.png");
  const text = await editorText(page);
  log("---- editor text after insert ----\n" + text + "\n----------------------------------");
  const bodyCount = text.split(SNIP_BODY).length - 1;
  check("snippet BODY inserted (original line + insertion = 2 occurrences)", bodyCount === 2, `count=${bodyCount}`);
  check("no /query token left behind", !text.includes(`/${SNIP_NAME}`));

  // Discard the transactional capture — no task file persists.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ==== B. Settings → Snippets tab lists it; Delete cleans it up ====
  await page.getByRole("button", { name: "Account" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Snippets" }).click();
  await page.waitForTimeout(600);
  await shot(page, "snip-06-settings-tab.png");
  check(
    "settings Snippets tab lists the saved snippet",
    (await page.getByText(SNIP_NAME, { exact: true }).count()) > 0,
  );
  check(
    "row shows the body preview",
    (await page.getByText(SNIP_BODY, { exact: true }).count()) > 0,
  );
  await page.getByRole("button", { name: `Delete ${SNIP_NAME}` }).click();
  await page.waitForTimeout(800);
  await shot(page, "snip-07-deleted.png");
  check(
    "Delete removes the row (live query)",
    (await page.getByText(SNIP_NAME, { exact: true }).count()) === 0,
  );
  await page.keyboard.press("Escape"); // close settings
  await page.waitForTimeout(400);

  // ==== C. Sandbox: multi-block SAMPLE snippet inserts as blocks ====
  await page.getByRole("button", { name: "Account" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "Editor Sandbox" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "component", exact: true }).click();
  await page.waitForTimeout(500);
  const sandboxEditor = page.locator(".hitch-editor-content");
  await sandboxEditor.first().click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/review-check");
  await page.waitForTimeout(400);
  await shot(page, "snip-08-sandbox-menu.png");
  check(
    "sandbox offers the multi-block sample snippet",
    (await page.getByText("review-checklist", { exact: true }).count()) > 0,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await shot(page, "snip-09-sandbox-inserted.png");
  const blockShape = await page.evaluate(() => {
    const root = document.querySelector(".hitch-editor-content");
    if (!root) return null;
    return {
      hasHeading: !!Array.from(root.querySelectorAll("h1,h2,h3")).find((h) =>
        (h.textContent ?? "").includes("Review checklist"),
      ),
      hasListItems: Array.from(root.querySelectorAll("li")).filter((li) =>
        ["correctness", "naming", "tests"].includes((li.textContent ?? "").trim()),
      ).length,
    };
  });
  check(
    "multi-block body inserted as a real heading block",
    blockShape?.hasHeading === true,
  );
  check(
    "list items inserted as real list blocks (3)",
    blockShape?.hasListItems === 3,
    `found=${blockShape?.hasListItems}`,
  );

  log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ====`);
  log("shots in", shots);
} catch (err) {
  console.error("check crashed:", err);
  failures++;
  await shot(page, "snip-99-crash.png");
} finally {
  await cleanup();
}
process.exit(failures === 0 ? 0 : 1);
