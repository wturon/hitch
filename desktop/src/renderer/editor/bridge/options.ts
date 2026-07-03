// The micromark / mdast-util extension wiring and the `toMarkdown` serialization
// options, kept in one place so import and export stay in lock-step.
//
// Serialization options are chosen to reproduce, byte-for-byte, how existing
// Hitch task files are authored — MDXEditor serializes with `mdast-util-to-
// markdown` and only overrides `bullet: "-"`, leaning on library defaults for
// everything else (ATX headings, `**` strong, `*` emphasis, `[text](url)`
// links, and `&#x20;` for significant trailing spaces). We match that exactly so
// loading and re-saving an untouched body produces a zero-byte git diff.
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type {
  Handle as ToMarkdownHandle,
  Options as ToMarkdownOptions,
} from "mdast-util-to-markdown";

// micromark tokenizer extensions for `fromMarkdown`.
// - GFM `~~strikethrough~~` is the only non-CommonMark construct the bridge
//   actually models as a Lexical node.
// - GFM tables are parsed so a table becomes a distinct `table` mdast node —
//   which `canImport` rejects, sending it to a byte-preserving UnknownBlockNode.
//   Without this extension a table mis-parses as a pipe-laden paragraph that the
//   editor would then present as (lossily) editable text. We only need the
//   FROM/syntax side: the export never sees a `table` node (it round-trips as an
//   opaque block), so there is deliberately no `gfmTableToMarkdown` below.
export const SYNTAX_EXTENSIONS = [gfmStrikethrough(), gfmTable()];

// mdast-util extensions that turn the raw tokens into typed mdast nodes
// (`delete` for strikethrough, `table`/`tableRow`/`tableCell` for tables).
export const MDAST_FROM_EXTENSIONS = [
  gfmStrikethroughFromMarkdown(),
  gfmTableFromMarkdown(),
];

// The matching serializer extension: teaches `toMarkdown` to render `delete`
// nodes back to `~~…~~`. Without it, a `delete` node throws on serialize.
// (No table serializer: tables leave via the verbatim UnknownBlock path.)
export const TO_MARKDOWN_EXTENSIONS = [gfmStrikethroughToMarkdown()];

// The custom serializer handler for `UnknownBlockNode`'s mdast node. It emits
// the stored source verbatim — no escaping, no re-wrapping — so the exact bytes
// the block was sliced from the original file come back out unchanged. This is
// what makes an unsupported construct (code fence, table, HTML, …) survive a
// load→save with zero churn. `handlers` is typed `Record<Nodes['type'], …>`, so
// `unknownBlock` — a type not in mdast's union — needs a cast; we keep it narrow
// (just this one key) rather than widening the whole options object.
const unknownBlockHandler: ToMarkdownHandle = (node) =>
  (node as { value: string }).value;

// Serialization overrides. Every entry is a deliberate match for how existing
// Hitch task files are authored; do not add options casually — each one is a
// potential source of diff churn against files already on disk.
export const TO_MARKDOWN_OPTIONS: ToMarkdownOptions = {
  // MDXEditor's one override: `-` bullets, not the library-default `*`.
  bullet: "-",
  // Thematic breaks as `---`, not the library-default `***` — task docs are
  // authored with `---`, so this keeps `<hr>` round-trips byte-exact. (Mirrors
  // the `bullet` override above: a canonical-form choice, not a stylistic one.)
  rule: "-",
  handlers: {
    // Cast: `unknownBlock` is our own node type, outside mdast's `Nodes` union,
    // so `Partial<Handlers>` won't accept the key without widening it here.
    unknownBlock: unknownBlockHandler,
  } as ToMarkdownOptions["handlers"],
};
