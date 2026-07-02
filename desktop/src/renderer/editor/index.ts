// Sole public entry for the Hitch editor folder. Nothing outside `editor/`
// should import its internals directly — import from `@/editor` instead.
// For now this exposes the Lexical sandbox and the mdast ⇄ Lexical bridge; the
// rest of the real editor lands here.
export { SandboxEditor } from "./SandboxEditor";
export {
  importMarkdown,
  exportMarkdown,
  UnsupportedMarkdownError,
} from "./bridge";
