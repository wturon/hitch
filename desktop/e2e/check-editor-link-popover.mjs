// Visual + behavioral check for the editor link popover (LinkPopoverPlugin). The
// plugin only mounts inside the production <MarkdownEditor>, which the sandbox's
// "component" mode drives — NOT the vanilla playground. Its seed doc has a
// `[funnel dashboard](https://example.com/dash)` link; clicking it moves the caret
// into the link, which opens the popover via the selection listener.
//
// Shots (e2e/shots/, uncommitted):
//   - preview popover, light + dark (the app drives dark off a `.dark` class on
//     <html> — see renderer/lib/theme.ts);
//   - edit state (after clicking the pencil), showing the URL input.
//
// Run against a throwaway Vite on 5199 (NEVER 5173, the live app):
//   npx vite --host 127.0.0.1 --port 5199   # in another shell (this worktree)
//   HITCH_DESKTOP_RENDERER_URL=http://127.0.0.1:5199 node e2e/check-editor-link-popover.mjs
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

const { page, cleanup } = await launchHitch({ profile: "link-popover-check" });
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

  // Switch to "component" mode — that pane mounts the production <MarkdownEditor>
  // (with LinkPopoverPlugin); the vanilla playground does not.
  await page.getByText("component", { exact: true }).click();
  await page.waitForTimeout(500);

  // Click the link text — a plain click moves the caret into the link, opening
  // the popover through the selection listener.
  const link = page
    .locator(".hitch-editor-content a", { hasText: "funnel dashboard" })
    .first();
  console.log("links rendered:", await page.locator(".hitch-editor-content a").count());
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await page.waitForTimeout(400);

  const preview = page.locator('[aria-label="Link preview"]');
  console.log("preview popover visible:", await preview.count());
  await shot(page, "02-preview-light.png");

  // Dark mode preview.
  await setDark(page, true);
  await page.waitForTimeout(300);
  await shot(page, "03-preview-dark.png");
  await setDark(page, false);
  await page.waitForTimeout(200);

  // Edit state — click the pencil, screenshot the URL input.
  await page.locator('[aria-label="Edit link"]').click();
  await page.waitForTimeout(300);
  const input = page.locator('input[aria-label="Link URL"]');
  console.log("edit input value:", await input.inputValue());
  await shot(page, "04-edit-light.png");

  // Escape returns to preview (input handles it), Escape again closes.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  console.log("after 1st Esc, preview visible:", await preview.count());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  console.log("after 2nd Esc, preview visible:", await preview.count());

  console.log("shots in", shots);
} finally {
  await cleanup();
}
