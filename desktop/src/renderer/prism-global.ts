// MDXEditor's codeBlockPlugin pulls in @lexical/code, which `require`s prismjs
// purely for its global side effect and then reads a *global* `Prism` (both
// `globalThis.Prism || window.Prism` and a bare `Prism` reference for its diff
// language patch). In dev, esbuild's dependency pre-bundling evaluates prism
// core first, so `window.Prism` is already set. The production Rollup build does
// not guarantee that ordering: the bundled language components / diff patch can
// run before prism core pins the global, throwing "Prism is not defined" at
// import time — which crashes the renderer before React mounts (white screen).
//
// Importing prism core here and pinning the global ourselves, in a module that
// is evaluated *before* App (and therefore before MDXEditor/Lexical), guarantees
// the global exists first. Keep this imported ahead of App in main.tsx.
import Prism from "prismjs";

(globalThis as unknown as { Prism: unknown }).Prism = Prism;
