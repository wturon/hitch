// Vendored markdown typing-shortcut engine for the Hitch editor. Replaces
// `@lexical/markdown` + `@lexical/react/LexicalMarkdownShortcutPlugin`, whose
// static `@lexical/code` (→ prismjs) import could never leave the production
// bundle. Everything here is copied from the installed 0.35.0 packages with only
// TS annotations added and the (unreachable) `$isCodeNode` guard dropped — see
// registerMarkdownShortcuts.ts. This folder is imported only from within
// `editor/` (config.ts, MarkdownEditor.tsx, SandboxEditor.tsx).
export { MarkdownShortcutPlugin } from "./MarkdownShortcutPlugin";
export { registerMarkdownShortcuts } from "./registerMarkdownShortcuts";
export {
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  LINK,
  TEXT_FORMAT_TRANSFORMERS,
} from "./transformers";
export type {
  Transformer,
  ElementTransformer,
  MultilineElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
} from "./types";
