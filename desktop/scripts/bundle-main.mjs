// Bundle the Electron main process so runtime dependencies such as
// electron-updater can ship without copying workspace node_modules into the app.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(__dirname, "../dist/main/main.js");

rmSync(`${outfile}.map`, { force: true });

await build({
  entryPoints: [resolve(__dirname, "../src/main/main.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["electron"],
  banner: {
    js: 'import { createRequire as __hitchCreateRequire } from "node:module"; const require = __hitchCreateRequire(import.meta.url);',
  },
  outfile,
  sourcemap: false,
  logLevel: "info",
});
