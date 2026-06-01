// Bundle the Hitch daemon into a single self-contained CommonJS file that ships
// inside the packaged app (Resources/daemon/runner.js) and runs under Electron's
// own Node via ELECTRON_RUN_AS_NODE (see desktop/src/main/main.ts).
//
// Why bundle instead of shipping daemon/dist + node_modules: deps are hoisted to
// the repo-root node_modules under npm workspaces, so a copied daemon/dist would
// not resolve them. esbuild inlines everything into one file with no runtime
// node_modules lookup. chokidar 5 dropped its fsevents dependency and uses native
// fs.watch, so there are no native modules to rebuild — the bundle is portable.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

await build({
  entryPoints: [resolve(repoRoot, "daemon/src/runner.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // Optional native perf addons for `ws`. They are not required — `ws` falls
  // back to its pure-JS path when they cannot be required — so we leave them
  // external rather than trying to bundle native code.
  external: ["bufferutil", "utf-8-validate"],
  outfile: resolve(__dirname, "../dist-daemon/runner.js"),
  logLevel: "info",
});
