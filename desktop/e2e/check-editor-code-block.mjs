// Visual + behavioral check for the editor code block's Shiki highlight overlay
// and keyboard containment. The vanilla sandbox's "Load sample" doc contains a
// ```ts fence that imports as a real, editable CodeBlockNode.
//
// Shots (e2e/shots/, uncommitted):
//   - highlighted ts block, light + dark (the app drives dark off a `.dark`
//     class on <html> — see renderer/lib/theme.ts);
//   - a LONG wrapping line, after clicking in and typing at the end — the caret
//     must sit exactly on the glyphs (overlay metric proof).
// Also asserts the containment fix at runtime: ⌥⌫ deletes a word natively inside
// the textarea and never leaks to Lexical (the surrounding doc is untouched).
//
// Run against a throwaway Vite on 5199 (NEVER 5173, the live app):
//   npx vite --host 127.0.0.1 --port 5199   # in another shell (this worktree)
//   HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 node e2e/check-editor-code-block.mjs
import { launchHitch } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(shots, name) });

const setDark = (page, on) =>
  page.evaluate((dark) => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, on);

const { page, cleanup } = await launchHitch({ profile: "code-block-check" });
try {
  await page.waitForTimeout(2500);
  await shot(page, "00-boot.png");

  // Open the sandbox via the command palette.
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(500);
  const entry = page.getByText("Editor Sandbox");
  if (await entry.count()) {
    await entry.first().click();
  } else {
    await page.keyboard.press("Escape");
    await page.locator("aside button, nav button").last().click();
    await page.waitForTimeout(400);
    await page.getByText("Editor Sandbox").first().click();
  }
  await page.waitForTimeout(600);
  await shot(page, "01-sandbox.png");

  // Vanilla mode is default; load the sample doc (contains the ```ts fence).
  await page.getByText("Load sample").click();
  await page.waitForTimeout(500);

  const block = page.locator('[data-editor-block-type="code"]');
  console.log("code blocks rendered:", await block.count());
  await block.first().scrollIntoViewIfNeeded();

  // Shiki loads lazily (dynamic import); give it a beat, then confirm token
  // spans exist (proves the overlay swapped from the plain fallback).
  await page.waitForTimeout(1500);
  const shikiSpans = await block.first().locator(".shiki span").count();
  console.log("shiki token spans in first block:", shikiSpans);

  await shot(page, "02-code-light.png");
  await block.first().screenshot({ path: join(shots, "02b-code-light-crop.png") });

  // Dark mode.
  await setDark(page, true);
  await page.waitForTimeout(300);
  await shot(page, "03-code-dark.png");
  await block.first().screenshot({ path: join(shots, "03b-code-dark-crop.png") });

  // Back to light for the wrapping / caret-alignment test.
  await setDark(page, false);
  await page.waitForTimeout(200);

  // Replace the block's code with a LONG single line that must wrap, then keep
  // typing at the end. The caret should ride the glyphs on the last wrapped row.
  const textarea = block.first().locator('textarea[aria-label="Code block"]');
  await textarea.click();
  await page.keyboard.press("Meta+a"); // native select-all inside the textarea
  const longLine =
    'const wrappingProbe = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt";';
  await textarea.pressSequentially(longLine, { delay: 4 });
  await page.waitForTimeout(400);
  const taValue = await textarea.inputValue();
  console.log("wrapping-line textarea length:", taValue.length);
  await block.first().scrollIntoViewIfNeeded();
  await shot(page, "04-wrapping-caret.png");
  await block
    .first()
    .screenshot({ path: join(shots, "04b-wrapping-caret-crop.png") });

  // Select a run near the end to show selection sits on the glyphs too.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForTimeout(200);
  await block
    .first()
    .screenshot({ path: join(shots, "05-wrapping-selection-crop.png") });

  // Containment fix: ⌥⌫ (delete word) must edit the textarea NATIVELY and never
  // reach Lexical. Reset to a known two-word line, caret at end, then ⌥⌫ once.
  await page.keyboard.press("Meta+a");
  await textarea.pressSequentially("alpha bravo", { delay: 8 });
  await page.waitForTimeout(150);
  await page.keyboard.press("Alt+Backspace");
  await page.waitForTimeout(200);
  const afterAltDelete = await textarea.inputValue();
  console.log("after ⌥⌫ (expect 'alpha '):", JSON.stringify(afterAltDelete));

  // ⌘⌫ (delete to line start) — also native.
  await page.keyboard.press("Meta+Backspace");
  await page.waitForTimeout(200);
  const afterMetaDelete = await textarea.inputValue();
  console.log("after ⌘⌫ (expect ''):", JSON.stringify(afterMetaDelete));

  // The block still exists (containment didn't let Lexical delete/mutate it).
  console.log("code blocks after modifier-deletes:", await block.count());

  console.log("shots in", shots);
} finally {
  await cleanup();
}
