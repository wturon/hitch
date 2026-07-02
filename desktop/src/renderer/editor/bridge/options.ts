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
import type { Options as ToMarkdownOptions } from "mdast-util-to-markdown";

// micromark tokenizer extensions for `fromMarkdown` — GFM `~~strikethrough~~`
// is the only non-CommonMark construct in the sandbox's node set.
export const SYNTAX_EXTENSIONS = [gfmStrikethrough()];

// mdast-util extensions that turn the strikethrough tokens into `delete` nodes.
export const MDAST_FROM_EXTENSIONS = [gfmStrikethroughFromMarkdown()];

// The matching serializer extension: teaches `toMarkdown` to render `delete`
// nodes back to `~~…~~`. Without it, a `delete` node throws on serialize.
export const TO_MARKDOWN_EXTENSIONS = [gfmStrikethroughToMarkdown()];

// The only override MDXEditor sets; every other default is intentional. Do not
// add options casually — each one is a potential source of diff churn against
// files already on disk.
export const TO_MARKDOWN_OPTIONS: ToMarkdownOptions = {
  bullet: "-",
};
