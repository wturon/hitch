// markdown string → Lexical nodes. Call inside `editor.update()`; it clears the
// root and rebuilds it from the parsed markdown. Visitor-per-node-type, the same
// architecture as MDXEditor's `importMarkdownToLexical` but trimmed to the
// sandbox's node set and with inline formatting threaded explicitly (a `format`
// bitmask passed down the recursion) instead of MDXEditor's mutable WeakMap.
//
// Scope: paragraph, heading (h1–h6), blockquote, ordered/unordered list (nested),
// link, and text with bold/italic/strikethrough/inline-code. Anything else —
// code fences, images, raw HTML, tables, hard breaks — hits no visitor and
// throws `UnsupportedMarkdownError` rather than being dropped.
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  Blockquote,
  Delete,
  Emphasis,
  Heading,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  Root,
  Strong,
  Text,
} from "mdast";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import type { HeadingTagType } from "@lexical/rich-text";
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
} from "@lexical/list";
import { $createLinkNode } from "@lexical/link";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
} from "lexical";

import { UnsupportedMarkdownError } from "./errors";
import { IS_BOLD, IS_CODE, IS_ITALIC, IS_STRIKETHROUGH } from "./format";
import {
  MDAST_FROM_EXTENSIONS,
  SYNTAX_EXTENSIONS,
} from "./options";

// The engine dispatches on `node.type`, so its plumbing takes `unknown` and
// casts internally: mdast's child arrays (`PhrasingContent[]`, which includes
// `html`, `image`, `break`) are wider than the sandbox's node set, and an
// index-signature struct type can't accept concrete mdast nodes cleanly.
// Individual visitors keep their precise mdast types; the registry widens them
// once, at registration, guarded by the `.type` string.
interface ImportContext {
  /** Inline format bitmask accumulated from enclosing strong/emphasis/delete. */
  format: number;
  /** Dispatch a single node against the visitor registry. */
  visit(node: unknown, parent: ElementNode, format: number): void;
  /** Dispatch every child of a parent node. */
  visitChildren(node: unknown, parent: ElementNode, format: number): void;
}

interface MdastImportVisitor<T> {
  type: string;
  // Method syntax (not an arrow property) so the heterogeneous registry stays
  // assignable under strictFunctionTypes.
  visit(node: T, parent: ElementNode, ctx: ImportContext): void;
}

// The widened handler shape stored in the registry. Concrete visitors are cast
// to this once (their `.type` guarantees they only ever receive their node).
type LooseImportVisitor = {
  type: string;
  visit(node: unknown, parent: ElementNode, ctx: ImportContext): void;
};

const ParagraphVisitor: MdastImportVisitor<Paragraph> = {
  type: "paragraph",
  visit(node, parent, ctx) {
    const paragraph = $createParagraphNode();
    parent.append(paragraph);
    ctx.visitChildren(node, paragraph, ctx.format);
  },
};

const HeadingVisitor: MdastImportVisitor<Heading> = {
  type: "heading",
  visit(node, parent, ctx) {
    // fromMarkdown only ever yields depth 1–6, but guard so a hand-built tree
    // can't smuggle in an out-of-range tag.
    if (node.depth < 1 || node.depth > 6) {
      throw new UnsupportedMarkdownError(`heading depth ${node.depth}`);
    }
    const heading = $createHeadingNode(`h${node.depth}` as HeadingTagType);
    parent.append(heading);
    ctx.visitChildren(node, heading, ctx.format);
  },
};

const BlockquoteVisitor: MdastImportVisitor<Blockquote> = {
  type: "blockquote",
  visit(node, parent, ctx) {
    const quote = $createQuoteNode();
    parent.append(quote);
    // Blockquote children are paragraphs; they become ParagraphNodes nested in
    // the QuoteNode (matching MDXEditor). Multi-paragraph quotes round-trip for
    // free because export walks those paragraphs straight back out.
    ctx.visitChildren(node, quote, ctx.format);
  },
};

const ListVisitor: MdastImportVisitor<List> = {
  type: "list",
  visit(node, parent, ctx) {
    const listType = node.ordered ? "number" : "bullet";
    const start = node.ordered ? (node.start ?? 1) : 1;
    const list = $createListNode(listType, start);
    if ($isListItemNode(parent)) {
      // Nested list. Lexical represents nesting as a ListItemNode whose sole
      // child is the nested ListNode, sitting AFTER the item it nests under.
      const wrapper = $createListItemNode();
      wrapper.append(list);
      parent.insertAfter(wrapper);
    } else {
      parent.append(list);
    }
    ctx.visitChildren(node, list, ctx.format);
  },
};

const ListItemVisitor: MdastImportVisitor<ListItem> = {
  type: "listItem",
  visit(node, parent, ctx) {
    const item = $createListItemNode();
    parent.append(item);
    let sawParagraph = false;
    for (const child of node.children) {
      if (child.type === "paragraph") {
        // A list item can only hold one text run in Lexical's model; a second
        // paragraph (loose, blank-line-separated) has no lossless mapping, so
        // fail loudly rather than silently concatenate.
        if (sawParagraph) {
          throw new UnsupportedMarkdownError("multiple paragraphs in a list item");
        }
        sawParagraph = true;
        // Unwrap: Lexical list items hold inline content directly, not a
        // paragraph wrapper. Export re-wraps it on the way out.
        ctx.visitChildren(child, item, ctx.format);
      } else if (child.type === "list") {
        // The nested list attaches AFTER `item` via ListVisitor's wrapper path.
        ctx.visit(child, item, ctx.format);
      } else {
        throw new UnsupportedMarkdownError(child.type);
      }
    }
  },
};

const LinkVisitor: MdastImportVisitor<Link> = {
  type: "link",
  visit(node, parent, ctx) {
    const link = $createLinkNode(node.url, { title: node.title ?? null });
    parent.append(link);
    ctx.visitChildren(node, link, ctx.format);
  },
};

const TextVisitor: MdastImportVisitor<Text> = {
  type: "text",
  visit(node, parent, ctx) {
    parent.append($createTextNode(node.value).setFormat(ctx.format));
  },
};

const EmphasisVisitor: MdastImportVisitor<Emphasis> = {
  type: "emphasis",
  visit(node, parent, ctx) {
    ctx.visitChildren(node, parent, ctx.format | IS_ITALIC);
  },
};

const StrongVisitor: MdastImportVisitor<Strong> = {
  type: "strong",
  visit(node, parent, ctx) {
    ctx.visitChildren(node, parent, ctx.format | IS_BOLD);
  },
};

const StrikethroughVisitor: MdastImportVisitor<Delete> = {
  type: "delete",
  visit(node, parent, ctx) {
    ctx.visitChildren(node, parent, ctx.format | IS_STRIKETHROUGH);
  },
};

const InlineCodeVisitor: MdastImportVisitor<InlineCode> = {
  type: "inlineCode",
  visit(node, parent, ctx) {
    // inlineCode is a leaf (no children); its value becomes a code-formatted
    // TextNode. Inline code can't carry other emphasis, so it keeps whatever
    // format the enclosing marks contributed plus the code bit.
    parent.append($createTextNode(node.value).setFormat(ctx.format | IS_CODE));
  },
};

const VISITOR_LIST: LooseImportVisitor[] = [
  ParagraphVisitor,
  HeadingVisitor,
  BlockquoteVisitor,
  ListVisitor,
  ListItemVisitor,
  LinkVisitor,
  TextVisitor,
  EmphasisVisitor,
  StrongVisitor,
  StrikethroughVisitor,
  InlineCodeVisitor,
].map((visitor) => visitor as unknown as LooseImportVisitor);

const VISITORS = new Map<string, LooseImportVisitor>(
  VISITOR_LIST.map((visitor) => [visitor.type, visitor]),
);

function visit(node: unknown, parent: ElementNode, format: number): void {
  const type = (node as { type: string }).type;
  const visitor = VISITORS.get(type);
  if (!visitor) {
    throw new UnsupportedMarkdownError(type);
  }
  visitor.visit(node, parent, { format, visit, visitChildren });
}

function visitChildren(node: unknown, parent: ElementNode, format: number): void {
  const children = (node as { children?: unknown[] }).children ?? [];
  for (const child of children) {
    visit(child, parent, format);
  }
}

/**
 * Parse `markdown` and rebuild the current editor's content from it. Must run
 * inside `editor.update()` — it touches `$getRoot()`. Throws
 * `UnsupportedMarkdownError` if the input contains a construct outside the
 * sandbox's node set; nothing is dropped silently.
 */
export function importMarkdown(markdown: string): void {
  const tree = fromMarkdown(markdown, {
    extensions: SYNTAX_EXTENSIONS,
    mdastExtensions: MDAST_FROM_EXTENSIONS,
  }) as Root;
  const root = $getRoot();
  root.clear();
  visitChildren(tree, root, 0);
}
