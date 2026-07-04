// End-to-end proof for the `/` menu's Skills section (Skills autocomplete v1),
// PLUS the two UI fixes from fix/slash-menu-width-zindex:
//   - Fix 1 (width): the widened menu (min-w-[300px]/max-w-[400px]) doesn't
//     truncate a moderately long skill name the way the old min-w-[220px] did.
//   - Fix 2 (z-index): the menu paints ON TOP of a TaskDialog (a modal Base UI
//     dialog) rather than behind it — the typeahead's anchor <div> now carries
//     `anchorClassName="z-[90]"` (see SlashMenuPlugin.tsx).
//
// The TaskDialog check runs FIRST (fresh boot lands on the Board), then the
// script switches to the Editor Sandbox's "component" mode — the production
// <MarkdownEditor> fed a hardcoded SAMPLE_SKILLS array (so the Skills section
// is exercisable without Convex/the daemon) — for the rest of the original
// Skills-autocomplete assertions plus the width check. It verifies that
// typing `/`:
//   - shows the Skills section BELOW the block commands (both visible at once);
//   - filters skills by the typed query alongside the block commands;
//   - keyboard nav flows across the section boundary (ArrowDown from a block
//     command into a skill);
//   - accepting a skill inserts PLAIN TEXT `/skill-name ` into the editor.
//
// Run against a throwaway Vite on 5199 (NEVER 5173, the live app):
//   npx vite --host 127.0.0.1 --port 5199        # in another shell (this worktree)
//   HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 node e2e/check-skills-slashmenu.mjs
import { launchHitch } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(shots, name) }).catch(() => {});
const log = (...a) => console.log(...a);

process.on("unhandledRejection", (e) => console.warn("late:", String(e)));

const { page, cleanup } = await launchHitch({ profile: "skills-slashmenu-check" });
page.on("dialog", (d) => d.dismiss().catch(() => {}));
let failures = 0;
const check = (label, ok, extra = "") => {
  log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

// Read the live text content of the production editor's contenteditable.
const editorText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".hitch-editor-content");
    return el ? el.textContent ?? "" : "";
  });

// The typeahead's own anchor <div> (LexicalTypeaheadMenuPlugin's
// `useMenuAnchorRef`) carries `role="listbox"` + `aria-label="Typeahead menu"`
// via `setContainerDivAttributes`, and our `SlashMenuList` portals in as its
// sole child — so this selector reaches the actual painted dropdown box
// regardless of which host page (Sandbox or TaskDialog) it's opened in.
const menuRoot = (page) =>
  page.locator('[aria-label="Typeahead menu"] > div').first();

// Fix 2's real proof: is the CENTER of the menu's own bounding box actually
// painting the menu (not something else on top of it, like a dialog overlay)?
// Keyboard-driven checks (menu opens, Enter selects) pass even when the menu
// is invisible behind a higher-stacked layer — only `elementFromPoint` catches
// that, since it reports whatever pixel is actually on top at that point.
async function menuIsVisibleOnTop(page) {
  const root = menuRoot(page);
  const box = await root.boundingBox();
  if (!box) return { onTop: false, box: null };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const onTop = await root.evaluate((el, [x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && el.contains(hit);
  }, [cx, cy]);
  return { onTop, box };
}

try {
  await page.waitForTimeout(2500);
  await shot(page, "skills-00-boot.png");

  // =========================================================================
  // Fix 2: the slash menu must paint ON TOP of a modal TaskDialog, not behind
  // it. Create a scratch task, open its dialog, type `/`, and prove the menu
  // is actually visible at the top of the stack (not just present in the DOM).
  // =========================================================================
  const title = `e2e-slashmenu-zindex-${Date.now()}`;
  const dialogOpen = () =>
    page.locator('[data-slot="dialog-content"]').count().then((n) => n > 0);
  try {
    const addTask = page.locator('[aria-label="Add task"]').first();
    await addTask.waitFor({ timeout: 25000 });
    await addTask.click();
    const editor = page.locator(".hitch-editor-content");
    await editor.first().waitFor({ timeout: 10000 });
    const titleBox = page.locator('textarea[aria-label="Task title"]');
    await titleBox.waitFor({ timeout: 10000 });
    await titleBox.click();
    await titleBox.fill(title);
    await page.waitForTimeout(200);
    check("TaskDialog opens for the scratch task", await dialogOpen());

    await editor.first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("/");
    await page.waitForTimeout(350);
    const rowCount = await page.locator('[role="option"]').count();
    check("slash menu opens inside the TaskDialog", rowCount > 0, `rows=${rowCount}`);
    await shot(page, "skills-10-taskdialog-menu-open.png");

    const { onTop, box } = await menuIsVisibleOnTop(page);
    check(
      "slash menu paints ON TOP of the TaskDialog (elementFromPoint hits the menu, not the dialog behind it)",
      onTop,
      box ? `box=${JSON.stringify(box)}` : "no menu box found",
    );

    // Close the menu and the dialog, then delete the scratch task — leave no
    // trace in the user's real board.
    await page.keyboard.press("Escape"); // closes the slash menu (Lexical KEY_ESCAPE)
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape"); // closes the TaskDialog (saves)
    await page.waitForTimeout(400);
  } finally {
    try {
      if (!(await dialogOpen())) {
        const card = page.getByText(title, { exact: false }).first();
        if (await card.count()) {
          await card.click();
          await page.waitForTimeout(400);
        }
      }
      const actions = page.locator('[aria-label="Task actions"]');
      if (await actions.count()) {
        await actions.first().click();
        await page.waitForTimeout(200);
        await page.getByRole("menuitem", { name: "Delete" }).first().click();
        await page.waitForTimeout(300);
      }
    } catch (e) {
      log("scratch task cleanup failed (non-fatal):", String(e));
    }
  }

  // --- Open the Editor Sandbox from the account menu, then switch to the
  // "component" tab (the real <MarkdownEditor>, which is where `skills` flows). ---
  await page.getByRole("button", { name: "Account" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: "Editor Sandbox" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "component", exact: true }).click();
  await page.waitForTimeout(500);
  const editor = page.locator(".hitch-editor-content");
  check("component-mode editor mounted", (await editor.count()) > 0);
  await shot(page, "skills-01-sandbox.png");

  // --- Put the caret on a fresh empty line so `/` triggers at block start. ---
  await editor.first().click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Meta+ArrowDown"); // to document end
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);

  // --- Type `/` → the full menu: block commands, then the Skills section. ---
  await page.keyboard.type("/");
  await page.waitForTimeout(400);
  await shot(page, "skills-02-menu-open.png");

  const skillsHeader = page.getByText("Skills", { exact: true });
  const headingRow = page.getByText("Heading 1", { exact: true });
  const beConciseRow = page.getByText("/be-concise", { exact: true });
  check("block commands present (Heading 1)", (await headingRow.count()) > 0);
  check("Skills section present below commands", (await skillsHeader.count()) > 0);
  check("sample skill row present (/be-concise)", (await beConciseRow.count()) > 0);
  // Harness badges render on the skill rows.
  check("harness badges render (CC)", (await page.getByText("CC").count()) > 0);

  // =========================================================================
  // Fix 1: the menu container widened from min-w-[220px] to min-w-[300px]/
  // max-w-[400px] specifically so a long skill name reads without truncating.
  // No SAMPLE_SKILLS entry is naturally that long (longest is "deploy-check"),
  // so this synthesizes the case the fix targets: swap a rendered name span's
  // text for a long name (the exact one from the bug report) and read
  // scrollWidth vs clientWidth — the same DOM node, same `truncate` class,
  // same flex layout the real component renders, just a longer string in it.
  // =========================================================================
  const menuBoxBeforeFilter = await menuRoot(page).boundingBox();
  check(
    "menu container widened to >= 300px (min-w-[300px])",
    !!menuBoxBeforeFilter && menuBoxBeforeFilter.width >= 300,
    `width=${menuBoxBeforeFilter?.width}`,
  );
  const longName = "thermo-nuclear-code-quality-review";
  // A `Locator` re-queries the DOM by its selector on every call — since we're
  // about to rename this exact node's text away from "/be-concise", grab a
  // stable `ElementHandle` up front so the read-back and restore below still
  // find the same node instead of failing to re-match the (now gone) text.
  const nameHandle = await page.getByText("/be-concise", { exact: true }).elementHandle();
  await nameHandle.evaluate((el, text) => {
    el.textContent = `/${text}`;
  }, longName);
  await page.waitForTimeout(50);
  await shot(page, "skills-02b-longname-injected.png");
  const nameFits = await nameHandle.evaluate((el) => el.scrollWidth <= el.clientWidth);
  check(
    `long skill name ("/${longName}") is not truncated (scrollWidth <= clientWidth)`,
    nameFits,
  );
  // Restore, so the rest of this script (which asserts on "/be-concise") sees
  // the real sample data again.
  await nameHandle.evaluate((el) => {
    el.textContent = "/be-concise";
  });

  // --- Filter: typing "be" narrows to just the be-concise skill (no block
  // command matches "be"), proving the shared query filters the skills section.
  // (Hyphen-free prefix: the typeahead's trigger stops matching at a `-`, so a
  // user filters by a contiguous non-hyphen prefix — exactly how autocomplete is
  // meant to be used.) ---
  await page.keyboard.type("be");
  await page.waitForTimeout(350);
  await shot(page, "skills-03-filtered.png");
  check(
    "query filters to the be-concise skill",
    (await page.getByText("/be-concise", { exact: true }).count()) > 0,
  );
  check(
    "non-matching block commands filtered out",
    (await page.getByText("Heading 1", { exact: true }).count()) === 0,
  );

  // --- Back to the unfiltered menu, then prove keyboard nav flows across the
  // section boundary: ArrowDown past all 8 block commands lands on the first
  // skill (be-concise), and Enter accepts it. ---
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  check(
    "backspacing restores the full menu (Heading 1 back)",
    (await page.getByText("Heading 1", { exact: true }).count()) > 0,
  );
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const selectedText = await page.evaluate(() => {
    const el = document.querySelector('[role="option"][aria-selected="true"]');
    return el ? el.textContent ?? "" : "";
  });
  log(`highlighted option after 8×ArrowDown: ${JSON.stringify(selectedText)}`);
  check(
    "ArrowDown crosses from commands into the skills section",
    selectedText.includes("/be-concise"),
    `selected="${selectedText}"`,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await shot(page, "skills-04-inserted.png");

  const text = await editorText(page);
  log("---- editor text after accept ----\n" + text + "\n----------------------------------");
  check(
    "accepting the skill inserts plain text /be-concise (with trailing space)",
    text.includes("/be-concise "),
    text.includes("/be-concise ") ? "" : `editor text was: ${JSON.stringify(text)}`,
  );
  // Exactly one occurrence — the accepted mention, not a leftover query fragment.
  const occurrences = text.split("/be-concise").length - 1;
  check("skill mention appears exactly once (query replaced, not appended)", occurrences === 1, `count=${occurrences}`);

  log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ====`);
  log("shots in", shots);
} catch (err) {
  console.error("check crashed:", err);
  failures++;
  try {
    await shot(page, "skills-99-crash.png");
  } catch {}
} finally {
  await cleanup();
}
process.exit(failures === 0 ? 0 : 1);
