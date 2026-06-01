// Write the app-config.json that ships in the packaged app's Resources/ folder.
// It carries the prod Convex deployment URL (not secret — the renderer bakes the
// same value) so the bundled daemon can reach the right backend without a system
// .env. main.ts reads it via readBakedConvexUrl() and passes CONVEX_URL to the
// daemon. In dev this file is absent and the daemon derives the URL from
// .env.local (CONVEX_DEPLOYMENT) as before.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "../dist-daemon");

const convexUrl = (
  process.env.CONVEX_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  ""
).trim();

if (!convexUrl) {
  console.warn(
    "[gen-app-config] WARNING: no CONVEX_URL / NEXT_PUBLIC_CONVEX_URL set. " +
      "The packaged daemon will have no backend URL baked in.",
  );
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "app-config.json"),
  `${JSON.stringify({ convexUrl }, null, 2)}\n`,
  "utf8",
);
console.log(`[gen-app-config] wrote app-config.json (convexUrl=${convexUrl || "<empty>"})`);
