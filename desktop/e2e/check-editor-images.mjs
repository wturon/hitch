// Visual check for editor image support: sandbox component mode should show the
// Skeleton while the fake preview handler delays (~800ms), then the tiny sample
// PNG, and right-click on the image should open the Copy/Delete context menu.
// Screenshots land in e2e/shots/ (uncommitted).
import { launchHitch } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(shots, name) });

const { page, cleanup } = await launchHitch({ profile: "images-check" });
try {
  await page.waitForTimeout(2500);
  await shot(page, "00-boot.png");

  // Try the command palette first; fall back to the account-menu entry.
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(500);
  await shot(page, "01-after-cmdk.png");

  let entry = page.getByText("Editor Sandbox");
  if (await entry.count()) {
    await entry.first().click();
  } else {
    await page.keyboard.press("Escape");
    // Account menu lives at the sidebar bottom; click whatever opens it.
    const trigger = page.locator('[data-account-menu], [aria-label*="ccount"]');
    if (await trigger.count()) await trigger.first().click();
    else {
      // Last resort: sidebar footer button (avatar/name).
      await page.locator("aside button, nav button").last().click();
    }
    await page.waitForTimeout(400);
    await shot(page, "02-menu.png");
    await page.getByText("Editor Sandbox").first().click();
  }
  await page.waitForTimeout(600);
  await shot(page, "03-sandbox.png");

  // Component mode (the harness with the fake image handlers).
  await page.getByText("component", { exact: true }).click();
  // Catch the Skeleton inside the ~800ms fake preview delay.
  await page.waitForTimeout(250);
  await shot(page, "04-image-skeleton.png");

  await page.waitForTimeout(2000);
  await shot(page, "05-image-loaded.png");

  const img = page.locator('[data-editor-block-type="image"] img');
  const count = await img.count();
  console.log("images rendered:", count);
  if (count > 0) {
    await img.first().click({ button: "right" });
    await page.waitForTimeout(500);
    await shot(page, "06-image-context-menu.png");
    const hasCopy = await page.getByText("Copy Image").count();
    console.log("context menu 'Copy Image' visible:", hasCopy > 0);
  }
  console.log("shots in", shots);
} finally {
  await cleanup();
}
