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
  // Prefer each package's ESM entry. esbuild's default for platform:"node" is
  // ["main","module"], which pulls jsonc-parser's UMD build — its factory calls
  // require("./impl/format") through a renamed binding esbuild can't follow, so
  // the require survives into the bundle and throws "Cannot find module
  // './impl/format'" at boot. The ESM build uses static imports esbuild inlines.
  mainFields: ["module", "main"],
  external: ["electron"],
  banner: {
    js: 'import { createRequire as __hitchCreateRequire } from "node:module"; const require = __hitchCreateRequire(import.meta.url);',
  },
  outfile,
  sourcemap: false,
  logLevel: "info",
});
