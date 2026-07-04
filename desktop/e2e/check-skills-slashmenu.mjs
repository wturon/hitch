// End-to-end proof for the `/` menu's Skills section (Skills autocomplete v1).
// Drives the Editor Sandbox's "component" mode — the production <MarkdownEditor>
// fed a hardcoded SAMPLE_SKILLS array (so the feature is exercisable without
// Convex/the daemon). It verifies that typing `/`:
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
const shot = (page, name) => page.screenshot({ path: join(shots, name) });
const log = (...a) => console.log(...a);

const { page, cleanup } = await launchHitch({ profile: "skills-slashmenu-check" });
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

try {
  await page.waitForTimeout(2500);
  await shot(page, "skills-00-boot.png");

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
