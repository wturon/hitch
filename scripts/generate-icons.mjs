// Regenerates every derived app-icon asset from the single master SVG.
//
//   node scripts/generate-icons.mjs   (or: npm run icons)
//
// Source of truth (tracked):
//   assets/icon.svg
// Tracked outputs (committed, consumed directly by the apps):
//   assets/icon.png                   1024px master raster (dev dock icon, electron-builder source)
//   desktop/src/renderer/public/      favicon.svg + favicon.ico for the renderer
// Build-only output (gitignored, regenerate on demand for packaging):
//   desktop/build/icon.icns           macOS .icns (via native `iconutil`)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const masterSvgPath = join(root, "assets/icon.svg");
const masterSvg = readFileSync(masterSvgPath);

function render(size) {
  const resvg = new Resvg(masterSvg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

// 1024px master PNG — dev dock icon (see main.ts) and electron-builder source.
writeFileSync(join(root, "assets/icon.png"), render(1024));

// macOS .icns via the native iconutil — build a .iconset then convert.
const iconset = mkdtempSync(join(tmpdir(), "hitch-iconset-")) + "/icon.iconset";
mkdirSync(iconset, { recursive: true });
const icnsSizes = [
  [16, "16x16"], [32, "16x16@2x"],
  [32, "32x32"], [64, "32x32@2x"],
  [128, "128x128"], [256, "128x128@2x"],
  [256, "256x256"], [512, "256x256@2x"],
  [512, "512x512"], [1024, "512x512@2x"],
];
for (const [size, name] of icnsSizes) {
  writeFileSync(join(iconset, `icon_${name}.png`), render(size));
}
mkdirSync(join(root, "desktop/build"), { recursive: true });
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(root, "desktop/build/icon.icns")]);
rmSync(dirname(iconset), { recursive: true, force: true });

// Favicons. Ship the SVG for modern browsers + a multi-size .ico fallback.
const ico = await pngToIco([render(16), render(32), render(48)]);
for (const dir of ["desktop/src/renderer/public"]) {
  mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(masterSvgPath, join(root, dir, "favicon.svg"));
  writeFileSync(join(root, dir, "favicon.ico"), ico);
}

console.log("Generated assets/icon.png, desktop/build/icon.icns, favicon.svg and favicon.ico from assets/icon.svg");
