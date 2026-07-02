import { defineConfig } from "vitest/config";

// Vitest for the desktop workspace. Scoped to the mdast ⇄ Lexical bridge for
// now (the first thing in the app with a headless, DOM-free test surface). The
// bridge and the headless Lexical editor run fine in a plain Node environment.
export default defineConfig({
  test: {
    include: ["src/renderer/editor/bridge/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
