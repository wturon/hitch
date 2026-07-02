// Thrown by `importMarkdown` when the input contains a construct the bridge
// deliberately doesn't model (code fences, images, raw HTML, tables, hard line
// breaks, headings outside h1–h6, …). The rule is fail-loud, never silently
// drop: the `.md` file is the agents' interface, so dropping content on load
// would corrupt it on the next save. Callers can catch this to fall back to a
// raw-text path, but the bridge itself refuses to lie about what it imported.
export class UnsupportedMarkdownError extends Error {
  /** The offending mdast node type or a short human name for the construct. */
  readonly construct: string;

  constructor(construct: string) {
    super(`Unsupported markdown construct: ${construct}`);
    this.name = "UnsupportedMarkdownError";
    this.construct = construct;
  }
}
