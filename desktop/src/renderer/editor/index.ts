// Sole public entry for the Hitch editor folder. Nothing outside `editor/`
// should import its internals directly — import from `@/editor` instead.
// For now this exposes the Lexical sandbox, the production `MarkdownEditor`, and
// the mdast ⇄ Lexical bridge; the rest of the real editor lands here.
export { SandboxEditor } from "./SandboxEditor";
export { MarkdownEditor } from "./MarkdownEditor";
export type { MarkdownEditorHandle, MarkdownEditorProps } from "./MarkdownEditor";
// The shape a surface (via useSkills) feeds into `MarkdownEditor`'s `skills` prop.
export type { SkillMenuItem } from "./SlashMenuPlugin";
export {
  importMarkdown,
  exportMarkdown,
  UnsupportedMarkdownError,
} from "./bridge";
