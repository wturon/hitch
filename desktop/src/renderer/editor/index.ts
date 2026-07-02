// Sole public entry for the Hitch editor folder. Nothing outside `editor/`
// should import its internals directly — import from `@/editor` instead.
// For now this only exposes the Lexical sandbox; the real editor lands here.
export { SandboxEditor } from "./SandboxEditor";
