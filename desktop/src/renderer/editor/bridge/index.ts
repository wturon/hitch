// The mdast ⇄ Lexical bridge: markdown string → Lexical state and back, with
// byte-for-byte round-trip fidelity as the hard requirement. UI-free (no React
// anywhere under `bridge/`); the editor folder re-exports this from its own
// `index.ts`, the only public entry.
export { importMarkdown } from "./importMarkdown";
export { exportMarkdown } from "./exportMarkdown";
export { UnsupportedMarkdownError } from "./errors";
