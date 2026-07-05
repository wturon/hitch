// End-to-end check for the Hitch-owned Lexical editor (@/editor) hosted inside
// the TodoDialog — the modal @base-ui dialog that replaced the board's old
// TaskDialog in Todos v1 (slice 6b).
//
// The editor's floating UI (link popover, slash menu, image context menu)
// portals to document.body — OUTSIDE the dialog popup DOM — so the risk this
// script exists to prove is the modal dialog's dismissal / focus-trap / pointer
// behavior fighting those portaled layers.
//
// Run against a throwaway Vite on 5199 (NEVER 5173, the live app):
//   npx vite --host 127.0.0.1 --port 5199        # in another shell (this worktree)
//   HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 node e2e/check-tododialog-editor.mjs
//
// It captures a clearly-named scratch todo (open capture → type → ⌘⏎ crystallizes
// it into the saved stage), exercises the dialog, and DELETES the scratch todo at
// the end via the ⋯ menu. All edits are confined to that scratch todo.
//
// NOT covered: image-paste upload — the isolated e2e profile has attachments
// disabled (no slug/storage), so imageUploadHandler is never wired. Expected.

import { launchHitch } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(shots, name) }).catch(() => {});
const log = (...a) => console.log(...a);

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const { page, cleanup } = await launchHitch({ profile: "tododialog-editor-check" });
page.on("dialog", (d) => d.dismiss().catch(() => {}));

let failures = 0;
const check = (label, ok, extra = "") => {
  log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

// Dialog is open iff its popup is in the DOM.
const dialogOpen = async () =>
  (await page.locator('[data-slot="todo-dialog"]').count()) > 0;
// Editor is mounted (formatted view) iff the contenteditable is present.
const editor = page.locator(".hitch-editor-content");

const title = `e2e-tododialog-${Date.now()}`;

// The Raw⇄Formatted toggle lives in the todo's "Todo actions" (…) menu.
async function pickMenuItem(name) {
  await page.locator('[aria-label="Todo actions"]').first().click();
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name }).first().click();
  await page.waitForTimeout(300);
}
async function toRaw() {
  const rawTa = page.locator('textarea[aria-label="Todo content"]');
  if ((await rawTa.count()) === 0) await pickMenuItem(/Raw markdown/i);
  return rawTa.first();
}
async function toFormatted() {
  const rawTa = page.locator('textarea[aria-label="Todo content"]');
  if ((await rawTa.count()) > 0) await pickMenuItem(/Formatted view/i);
  await editor.first().waitFor({ timeout: 5000 });
}

// Last-resort watchdog so a stuck selector can never hang the run forever.
const watchdog = setTimeout(() => {
  log("WATCHDOG: run exceeded 180s, exiting");
  cleanup().finally(() => process.exit(2));
}, 180000);

try {
  // --- Boot signed-in -------------------------------------------------------
  const addTodo = page.getByRole("button", { name: "Add a todo…" }).first();
  await addTodo.waitFor({ timeout: 25000 });
  await shot(page, "td-00-todos.png");
  check("boots signed-in (Todos view renders)", true);

  // --- Capture a scratch todo, then crystallize it into the saved stage -----
  // Capture is body-only; the first line becomes the title on ⌘⏎, and the card
  // transforms in place into the saved (edit/delegate) stage — same dialog, now
  // with a title textarea + the ⋯ menu.
  await addTodo.click();
  await editor.first().waitFor({ timeout: 10000 });
  await editor.first().click();
  await page.keyboard.type(title);
  await page.keyboard.press("Meta+Enter");
  const titleBoxNew = page.locator('textarea[aria-label="Todo title"]');
  await titleBoxNew.waitFor({ timeout: 10000 });
  await page.waitForTimeout(300); // let the ~250ms transform window settle
  await shot(page, "td-01-dialog-open.png");
  check("capture ⌘⏎ crystallizes into the saved stage", await dialogOpen());

  // ===================================================================
  // 1. New editor mounted; NO old MDXEditor element.
  // ===================================================================
  const hasNew = (await editor.count()) > 0;
  const hasOldMdx =
    (await page.locator(".hitch-mdx, .hitch-mdx-content, .hitch-mdx-host").count()) > 0;
  check("1. new editor mounted (.hitch-editor-content, no .hitch-mdx)", hasNew && !hasOldMdx,
    `new=${hasNew} old=${hasOldMdx}`);

  // ===================================================================
  // 2. Typing + `# ` heading + `**bold**` inline shortcut.
  // ===================================================================
  await editor.first().click();
  await page.waitForTimeout(150);
  await page.keyboard.type("# My Heading");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.keyboard.type("A paragraph with **bold** text.");
  await page.waitForTimeout(200);
  const h1 = await editor.locator("h1").count();
  const strong = await editor.locator("strong").count();
  check("2. `# ` produced a real <h1>", h1 >= 1, `h1=${h1}`);
  check("2. `**bold**` produced a <strong>", strong >= 1, `strong=${strong}`);
  await shot(page, "td-02-heading-bold.png");

  // ===================================================================
  // 3. ``` + space → code block; typing lands in .hitch-code-textarea.
  // ===================================================================
  await editor.first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // The CODE_BLOCK_TRANSFORMER regex is /^```([\w#+.-]*) $/ — fence + trailing
  // space at the start of an empty paragraph.
  await page.keyboard.type("```");
  await page.keyboard.type(" ");
  await page.waitForTimeout(300);
  let codeBlocks = await editor.locator('[data-editor-block-type="code"]').count();
  let usedSlashFallback = false;
  if (codeBlocks < 1) {
    // Fallback: the `/` slash menu (also a supported create path). Recorded so
    // the report is honest about which trigger fired.
    usedSlashFallback = true;
    await page.keyboard.type("/code");
    await page.waitForTimeout(350);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    codeBlocks = await editor.locator('[data-editor-block-type="code"]').count();
  }
  // focusCodeBlockOnMount focuses the new block's textarea; type into it.
  await page.keyboard.type("const x = 1;");
  await page.waitForTimeout(250);
  const codeTextareaVal = await page
    .locator(".hitch-code-textarea")
    .first()
    .inputValue()
    .catch(() => "");
  check(
    "3. ``` + space created a code block, typing lands in its textarea",
    codeBlocks >= 1 && codeTextareaVal.includes("const x = 1;"),
    `codeBlocks=${codeBlocks} textarea="${codeTextareaVal}" slashFallback=${usedSlashFallback}`,
  );
  await shot(page, "td-03-codeblock.png");

  // ===================================================================
  // 4. Slash menu opens on `/`, arrow + Enter inserts (divider);
  //    the DIALOG MUST STAY OPEN throughout.
  // ===================================================================
  // The ``` code block above is the terminal node with no editable paragraph
  // after it, so anchor to the (always-editable) bold paragraph and open a fresh
  // empty paragraph right after it to host the slash trigger.
  const anchorPara = editor.locator("p", { hasText: "paragraph with" }).first();
  await anchorPara.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.waitForTimeout(350);
  const slashMenu = page.locator('[role="option"]');
  const slashOpen = (await slashMenu.count()) > 0;
  const dialogDuringSlash = await dialogOpen();
  await shot(page, "td-04-slashmenu.png");
  // Navigate to "Divider" (last item). Filtering is more robust than counting
  // arrow presses.
  await page.keyboard.type("divider");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const hrCount = await editor.locator("hr").count();
  const dialogAfterSlash = await dialogOpen();
  check(
    "4. slash menu opens on `/` and dialog stays open",
    slashOpen && dialogDuringSlash && dialogAfterSlash,
    `menuOpen=${slashOpen} dialogDuring=${dialogDuringSlash} dialogAfter=${dialogAfterSlash}`,
  );
  check("4. slash-menu selection inserted a divider (<hr>)", hrCount >= 1, `hr=${hrCount}`);

  // ===================================================================
  // 5. Link flow (THE most important check): create a link, click it →
  //    popover on top of the dialog, click Edit, change URL, Enter →
  //    URL updated, DIALOG STILL OPEN.
  // ===================================================================
  const anchorPara2 = editor.locator("p", { hasText: "paragraph with" }).first();
  await anchorPara2.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // Type markdown the LINK transformer converts to a real link node.
  await page.keyboard.type("See [site](https://example.com) now.");
  await page.waitForTimeout(300);
  const linkEl = editor.locator("a", { hasText: "site" }).first();
  const linkMade = (await linkEl.count()) > 0;
  check("5a. `[site](url)` produced a link node", linkMade, `link=${linkMade}`);

  // Click into the link → popover appears (selection-driven).
  await linkEl.click();
  await page.waitForTimeout(400);
  const popover = page.locator('[aria-label="Link preview"]');
  const popoverOpen = (await popover.count()) > 0;
  const dialogWithPopover = await dialogOpen();
  check("5b. clicking the link opens the popover", popoverOpen, `popover=${popoverOpen}`);
  check("5c. dialog stays open while the popover is up", dialogWithPopover);
  await shot(page, "td-05a-link-popover.png");

  // Popover must be positioned near/under the link and on top (z above dialog).
  if (popoverOpen) {
    const linkBox = await linkEl.boundingBox();
    const popBox = await popover.boundingBox();
    const positioned =
      !!linkBox && !!popBox && popBox.y >= linkBox.y - 4 && Math.abs(popBox.x - linkBox.x) < 400;
    check("5d. popover positioned under the link", positioned,
      popBox && linkBox ? `linkY=${Math.round(linkBox.y)} popY=${Math.round(popBox.y)}` : "no box");
  }

  // Click Edit (pencil) → URL input; type a new URL; Enter → URL updated.
  const editBtn = page.locator('[aria-label="Edit link"]');
  await editBtn.click();
  await page.waitForTimeout(300);
  const urlInput = page.locator('input[aria-label="Link URL"]');
  const inputShown = (await urlInput.count()) > 0;
  check("5e. Edit opens the URL input, dialog still open",
    inputShown && (await dialogOpen()), `input=${inputShown}`);
  await shot(page, "td-05b-link-edit.png");
  if (inputShown) {
    await urlInput.click();
    // Focus into the outside-the-popup input must NOT dismiss the dialog.
    await page.waitForTimeout(150);
    const dialogAfterInputFocus = await dialogOpen();
    check("5f. focusing the URL input (outside popup) keeps the dialog open",
      dialogAfterInputFocus);
    const focusedInput = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label") === "Link URL");
    check("5g. URL input actually holds focus (no focus-trap steal)", focusedInput);
    await urlInput.fill("https://updated.example.org");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
  }
  const dialogAfterEdit = await dialogOpen();
  // Confirm the href updated by reading raw markdown.
  const rawAfterLink = await (await toRaw()).inputValue();
  await toFormatted();
  check(
    "5h. link URL updated AND dialog stayed open (THE key check)",
    dialogAfterEdit && rawAfterLink.includes("https://updated.example.org"),
    `dialogOpen=${dialogAfterEdit} hasNewUrl=${rawAfterLink.includes("https://updated.example.org")}`,
  );
  await shot(page, "td-05c-link-updated.png");

  // ===================================================================
  // 6. Escape chain: popover open → Esc closes popover, dialog STAYS;
  //    Esc again → dialog closes (and saves). Reopen → content persisted.
  // ===================================================================
  const link2 = editor.locator("a", { hasText: "site" }).first();
  await link2.click();
  await page.waitForTimeout(350);
  const popBeforeEsc = (await popover.count()) > 0;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  const popAfterEsc1 = await popover.count();
  const dialogAfterEsc1 = await dialogOpen();
  check("6a. first Esc closes the popover", popBeforeEsc && popAfterEsc1 === 0,
    `before=${popBeforeEsc} after=${popAfterEsc1}`);
  check("6b. first Esc does NOT close the dialog", dialogAfterEsc1);
  await shot(page, "td-06a-after-first-esc.png");

  // Second Esc → dialog closes (and saves).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const dialogAfterEsc2 = await dialogOpen();
  check("6c. second Esc closes the dialog (saves)", !dialogAfterEsc2);
  await shot(page, "td-06b-after-second-esc.png");

  // Reopen the todo → content persisted. A Todos row is a role=button labelled
  // with the todo title.
  const reopen = page.getByText(title, { exact: false }).first();
  await reopen.waitFor({ timeout: 10000 });
  await reopen.click();
  await editor.first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  const reopenedRaw = await (await toRaw()).inputValue();
  await toFormatted();
  check(
    "6d. reopen restores persisted content",
    reopenedRaw.includes("My Heading") &&
      reopenedRaw.includes("const x = 1;") &&
      reopenedRaw.includes("updated.example.org"),
    `hasHeading=${reopenedRaw.includes("My Heading")} hasCode=${reopenedRaw.includes("const x = 1;")}`,
  );
  await shot(page, "td-06c-reopened.png");

  // ===================================================================
  // 7. Raw ⇄ formatted byte-safety: seed exotic content via raw, flip to
  //    formatted (opaque cards), flip back → byte-identical.
  // ===================================================================
  const rawTa = await toRaw();
  const current = await rawTa.inputValue();
  const fmMatch = current.match(/^---\n[\s\S]*?\n---\n/);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const exoticBody = [
    "Intro paragraph, normal text.",
    "",
    "| Col A | Col B |",
    "| ----- | ----- |",
    "| 1     | 2     |",
    "",
    "~~~python",
    "print('tilde fence')",
    "~~~",
    "",
    "<!-- an html comment -->",
    "",
    "A normal closing paragraph.",
    "",
  ].join("\n");
  const seed = frontmatter + exoticBody;
  await rawTa.click();
  await rawTa.fill(seed);
  await page.waitForTimeout(300);
  const seedReadback = await rawTa.inputValue();
  check("7a. seed written to raw view", seedReadback === seed);

  await toFormatted();
  await page.waitForTimeout(300);
  const editorSurvives = (await editor.count()) > 0;
  const opaqueCount = await page.getByText("unsupported markdown", { exact: false }).count();
  check("7b. formatted view survives exotic content (no crash)", editorSurvives);
  check("7c. exotic constructs render as opaque cards", opaqueCount >= 1, `opaque=${opaqueCount}`);
  await shot(page, "td-07-exotic-formatted.png");

  const rawAfterRoundtrip = await (await toRaw()).inputValue();
  const byteSafe = rawAfterRoundtrip === seed;
  check("7d. BYTE-SAFETY: raw→formatted→raw is byte-identical", byteSafe,
    byteSafe ? "" : "DRIFT — see diff below");
  if (!byteSafe) {
    const ea = seed.split("\n");
    const ra = rawAfterRoundtrip.split("\n");
    for (let i = 0; i < Math.max(ea.length, ra.length); i++) {
      if (ea[i] !== ra[i]) log(`  line ${i}: expected=${JSON.stringify(ea[i])} got=${JSON.stringify(ra[i])}`);
    }
  }
  await toFormatted();

  // ===================================================================
  // 8. Focus flows: Enter in title → body; click empty area → body end.
  // ===================================================================
  const titleBox = page.locator('textarea[aria-label="Todo title"]');
  await titleBox.click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const bodyFocusedAfterTitleEnter = await page.evaluate(
    () => document.activeElement?.classList?.contains("hitch-editor-content") ?? false,
  );
  check("8a. Enter in title moves focus into the body (focusStart)", bodyFocusedAfterTitleEnter);

  // Click empty space below the content → focusEnd lands the caret in the body.
  await titleBox.click();
  await page.waitForTimeout(100);
  const pane = page
    .locator("div.overflow-y-auto")
    .filter({ has: editor })
    .first();
  const box = await pane.boundingBox();
  if (box) {
    // Low + right margin: the scroll pane itself, not a child node.
    await page.mouse.click(box.x + box.width - 24, box.y + box.height - 60);
    await page.waitForTimeout(250);
  }
  const bodyFocusedAfterEmptyClick = await page.evaluate(
    () => document.activeElement?.classList?.contains("hitch-editor-content") ?? false,
  );
  check("8b. clicking empty area below content focuses the body (focusEnd)",
    bodyFocusedAfterEmptyClick);
  await shot(page, "td-08-focus-flows.png");

  // ===================================================================
  // 9. Placeholder shows on an empty body.
  // ===================================================================
  // Clear the body via raw view (wipe body, keep frontmatter), flip back.
  const rawTa2 = await toRaw();
  const cur2 = await rawTa2.inputValue();
  const fm2 = (cur2.match(/^---\n[\s\S]*?\n---\n/) || [""])[0];
  await rawTa2.click();
  await rawTa2.fill(fm2);
  await page.waitForTimeout(250);
  await toFormatted();
  await page.waitForTimeout(300);
  const placeholderText = "Describe what you're working on";
  const placeholderShown =
    (await page.getByText(placeholderText, { exact: false }).count()) > 0;
  check("9. placeholder shows on an empty body", placeholderShown, `text="${placeholderText}"`);
  await shot(page, "td-09-placeholder.png");

  log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ====`);
  log("shots in", shots);
} catch (err) {
  console.error("check crashed:", err);
  failures++;
  await shot(page, "td-99-crash.png");
} finally {
  // --- Best-effort cleanup: delete the scratch todo -------------------------
  try {
    // If the dialog is closed, reopen the todo row so the delete menu is reachable.
    if (!(await dialogOpen())) {
      const c = page.getByText(title, { exact: false }).first();
      if (await c.count()) {
        await c.click();
        await page.waitForTimeout(400);
      }
    }
    const actions = page.locator('[aria-label="Todo actions"]');
    if (await actions.count()) {
      await actions.first().click();
      await page.waitForTimeout(200);
      await page.getByRole("menuitem", { name: "Delete" }).first().click();
      await page.waitForTimeout(300);
    }
  } catch {
    /* leave it; it's clearly named */
  }
  clearTimeout(watchdog);
  await cleanup();
}
process.exit(failures === 0 ? 0 : 1);
