// Visual check for the editor code block: the vanilla sandbox's "Load sample"
// doc now contains a ```ts fence that imports as a real, editable CodeBlockNode.
// Shoots the block in light and dark mode (the app drives dark off a `.dark`
// class on <html> — see renderer/lib/theme.ts) and with the language dropdown
// open. Screenshots land in e2e/shots/ (uncommitted).
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
  await page.waitForTimeout(200);
  await shot(page, "02-code-light.png");
  await block.first().screenshot({ path: join(shots, "02b-code-light-crop.png") });

  // Dark mode.
  await setDark(page, true);
  await page.waitForTimeout(300);
  await shot(page, "03-code-dark.png");
  await block.first().screenshot({ path: join(shots, "03b-code-dark-crop.png") });

  // Language dropdown open (back in light for clarity).
  await setDark(page, false);
  await page.waitForTimeout(200);
  const trigger = block.first().locator('[data-slot="select-trigger"]');
  console.log("language trigger present:", await trigger.count());
  await trigger.first().click();
  await page.waitForTimeout(400);
  await shot(page, "04-language-open.png");
  const items = await page.locator('[data-slot="select-item"]').count();
  console.log("language options visible:", items);

  console.log("shots in", shots);
} finally {
  await cleanup();
}
