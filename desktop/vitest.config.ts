import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vitest for the desktop workspace. Two kinds of tests live here:
//   - the mdast ⇄ Lexical bridge — headless, DOM-free, runs in plain Node;
//   - the editor component tests (MarkdownEditor's controlled contract) — need a
//     DOM, so those files opt into jsdom with a `// @vitest-environment jsdom`
//     pragma at the top. The default environment stays `node` so the bridge
//     suite is untouched.
export default defineConfig({
  // Use the automatic JSX runtime (react/jsx-runtime) so the component tests'
  // JSX works without React in scope — matches tsconfig.renderer's `react-jsx`.
  // Only affects .tsx/.jsx; the .ts bridge tests transform identically to before.
  esbuild: { jsx: "automatic" },
  resolve: {
    // Match vite.config.ts so component tests can import via `@/…` (the component
    // pulls in `@/lib/utils`). The bridge tests use relative imports and don't
    // depend on this.
    alias: {
      "@": resolve(__dirname, "src/renderer"),
    },
  },
  test: {
    include: [
      "src/renderer/editor/bridge/__tests__/**/*.test.ts",
      "src/renderer/editor/__tests__/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
