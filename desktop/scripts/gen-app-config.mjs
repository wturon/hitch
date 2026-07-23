// Write the app-config.json that ships in the packaged app's Resources/ folder.
// It carries the prod Hitch server URL (Railway) so a packaged build runs
// against prod without a system .env. main.ts reads it via readBakedServerUrl()
// and promotes it into HITCH_SERVER_URL for the renderer, auth, and the daemon.
// In dev this file is absent and the URL comes from the HITCH_SERVER_URL env var
// (e.g. `npm run dev:v2-stack`).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "../dist-daemon");

const serverUrl = (
  process.env.HITCH_SERVER_URL ??
  process.env.VITE_HITCH_SERVER_URL ??
  ""
)
  .trim()
  .replace(/\/+$/, "");

if (!serverUrl) {
  console.warn(
    "[gen-app-config] WARNING: no HITCH_SERVER_URL set. " +
      "The packaged app will have no server URL baked in.",
  );
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "app-config.json"),
  `${JSON.stringify({ serverUrl }, null, 2)}\n`,
  "utf8",
);
console.log(`[gen-app-config] wrote app-config.json (serverUrl=${serverUrl || "<empty>"})`);
