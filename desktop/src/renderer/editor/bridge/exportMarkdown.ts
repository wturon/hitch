// Lexical nodes → markdown string. Call inside `editorState.read()`; it walks
// the tree from `$getRoot()` into an mdast tree, then serializes with
// `mdast-util-to-markdown`. Visitor-per-node-type, mirroring MDXEditor's
// `exportMarkdownFromLexical` — including its `appendToParent` + `shouldJoin`
// merging, which is what keeps adjacent same-format runs from emitting doubled
// markers (e.g. `**a b**`, not `**a****b**`).
//
// Note on the trailing newline: `mdast-util-to-markdown` already terminates its
// output with a single "\n", so — unlike MDXEditor, which appends another and
// relies on a downstream trim — we return the serializer output verbatim. That
// yields canonical single-trailing-newline markdown that round-trips cleanly.
import { toMarkdown } from "mdast-util-to-markdown";
import type { Root } from "mdast";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $isListItemNode, $isListNode } from "@lexical/list";
import { $isLinkNode } from "@lexical/link";
import { $isHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import {
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRootNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";

import {
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  SUPPORTED_FORMATS,
} from "./format";
import { $isUnknownBlockNode } from "../nodes/UnknownBlockNode";
import { $isImageNode } from "../nodes/ImageNode";
import { TO_MARKDOWN_EXTENSIONS, TO_MARKDOWN_OPTIONS } from "./options";

// A loosely-typed mdast node under construction. The visitors build plain
// objects; the finished tree is asserted to `Root` for the serializer.
interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  [key: string]: unknown;
}

interface ExportActions {
  /** Append a fresh mdast node and, for element nodes, recurse into children. */
  addAndStepInto(
    type: string,
    props?: Record<string, unknown>,
    hasChildren?: boolean,
  ): void;
  /** Append `node` under `parentNode`, applying any `shouldJoin` merge. */
  appendToParent(parentNode: MdastNode | null, node: MdastNode): MdastNode;
  /** Visit every Lexical child of `lexicalNode` into `parentNode`. */
  visitChildren(lexicalNode: ElementNode, parentNode: MdastNode): void;
  /** Dispatch a single Lexical node against the registry. */
  visit(lexicalNode: LexicalNode, mdastParent: MdastNode | null): void;
}

interface LexicalExportVisitor {
  testLexicalNode(node: LexicalNode): boolean;
  visitLexicalNode(args: {
    lexicalNode: LexicalNode;
    mdastParent: MdastNode;
    actions: ExportActions;
  }): void;
  // Adjacent-sibling merge: return true to fold `next` into `prev` via `join`.
  shouldJoin?(prev: MdastNode, next: MdastNode): boolean;
  join?(prev: MdastNode, next: MdastNode): MdastNode;
}

function isMdastParent(node: MdastNode): node is MdastNode & { children: MdastNode[] } {
  return Array.isArray(node.children);
}

const RootVisitor: LexicalExportVisitor = {
  testLexicalNode: $isRootNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto("root");
  },
};

const ParagraphVisitor: LexicalExportVisitor = {
  testLexicalNode: $isParagraphNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto("paragraph");
  },
};

const HeadingVisitor: LexicalExportVisitor = {
  testLexicalNode: $isHeadingNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    if (!$isHeadingNode(lexicalNode)) return;
    const depth = Number.parseInt(lexicalNode.getTag().slice(1), 10);
    actions.addAndStepInto("heading", { depth });
  },
};

const QuoteVisitor: LexicalExportVisitor = {
  testLexicalNode: $isQuoteNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto("blockquote");
  },
};

const ListVisitor: LexicalExportVisitor = {
  testLexicalNode: $isListNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    if (!$isListNode(lexicalNode)) return;
    const listType = lexicalNode.getListType();
    if (listType !== "bullet" && listType !== "number") {
      // "check" lists aren't in scope (no checkbox node registered).
      throw new Error(`Unsupported list type: ${listType}`);
    }
    const ordered = listType === "number";
    actions.addAndStepInto("list", {
      ordered,
      // mdast wants `start` only for ordered lists; keep `null` otherwise so the
      // serializer stays on its default path.
      start: ordered ? lexicalNode.getStart() : null,
      // Force tight lists (no blank line between items) — matches how bodies are
      // authored and avoids re-emitting a "loose" list the user never made.
      spread: false,
    });
  },
};

const ListItemVisitor: LexicalExportVisitor = {
  testLexicalNode: $isListItemNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    if (!$isListItemNode(lexicalNode)) return;
    const children = lexicalNode.getChildren();
    const firstChild = children[0];
    if (children.length === 1 && $isListNode(firstChild)) {
      // This item is Lexical's nested-list wrapper (its only child is a list).
      // Fold that nested list into the PREVIOUS mdast list item, which is where
      // markdown expects a sub-list to live.
      const prev = mdastParent.children?.at(-1);
      if (!prev) {
        actions.visitChildren(lexicalNode, mdastParent);
      } else {
        actions.visitChildren(lexicalNode, prev);
      }
      return;
    }
    const listItem = actions.appendToParent(mdastParent, {
      type: "listItem",
      spread: false,
      children: [],
    });
    // Re-wrap the item's inline run in a paragraph (import unwrapped it). A
    // non-inline child (a nested list) breaks the run and is visited directly.
    let paragraph: MdastNode | null = null;
    for (const child of children) {
      const isInline =
        $isTextNode(child) ||
        $isLineBreakNode(child) ||
        (($isElementNode(child) || $isDecoratorNode(child)) && child.isInline());
      if (isInline) {
        paragraph ??= actions.appendToParent(listItem, {
          type: "paragraph",
          children: [],
        });
        actions.visit(child, paragraph);
      } else {
        paragraph = null;
        actions.visit(child, listItem);
      }
    }
  },
};

const LinkVisitor: LexicalExportVisitor = {
  testLexicalNode: $isLinkNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    if (!$isLinkNode(lexicalNode)) return;
    actions.addAndStepInto("link", {
      url: lexicalNode.getURL(),
      title: lexicalNode.getTitle(),
    });
  },
};

const LineBreakVisitor: LexicalExportVisitor = {
  testLexicalNode: $isLineBreakNode,
  visitLexicalNode: ({ mdastParent, actions }) => {
    // A HARD line break inside a paragraph (Shift+Enter, or an imported `\`).
    // Emit a real mdast `break` so the serializer renders the `\` form — not a
    // "\n" text node, which would collapse into a soft break. Source authored
    // with the two-trailing-spaces hard-break form normalizes to `\` (a
    // normalize-once case, covered by the idempotence suite). Soft breaks stay
    // as `\n` inside text node values and never reach this visitor.
    actions.appendToParent(mdastParent, { type: "break" });
  },
};

const HorizontalRuleVisitor: LexicalExportVisitor = {
  testLexicalNode: $isHorizontalRuleNode,
  visitLexicalNode: ({ actions }) => {
    // No children; `rule: "-"` (options.ts) makes this serialize as `---`.
    actions.addAndStepInto("thematicBreak", {}, false);
  },
};

const UnknownBlockVisitor: LexicalExportVisitor = {
  testLexicalNode: $isUnknownBlockNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    if (!$isUnknownBlockNode(lexicalNode)) return;
    // Emit a custom `unknownBlock` mdast node carrying the stored source; the
    // `unknownBlock` handler in TO_MARKDOWN_OPTIONS writes `value` verbatim
    // (no escaping), so the exact bytes we sliced on import come back out.
    actions.addAndStepInto(
      "unknownBlock",
      { value: lexicalNode.getSource() },
      false,
    );
  },
};

const ImageVisitor: LexicalExportVisitor = {
  testLexicalNode: $isImageNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    if (!$isImageNode(lexicalNode)) return;
    // A leaf mdast `image` appended into the enclosing paragraph. `alt: ""`
    // serializes to `![](url)`; a non-null `title` becomes `![alt](url "title")`.
    actions.appendToParent(mdastParent, {
      type: "image",
      url: lexicalNode.getSrc(),
      alt: lexicalNode.getAltText(),
      title: lexicalNode.getTitle(),
    });
  },
};

const TextVisitor: LexicalExportVisitor = {
  // Merge adjacent same-type inline wrappers so a run split across Lexical text
  // nodes serializes with a single marker pair.
  shouldJoin: (prev, next) => {
    if (["text", "emphasis", "strong", "delete"].includes(prev.type)) {
      return prev.type === next.type;
    }
    return false;
  },
  join(prev, next) {
    if (prev.type === "text" && next.type === "text") {
      return { type: "text", value: `${prev.value ?? ""}${next.value ?? ""}` };
    }
    return {
      ...prev,
      children: [...(prev.children ?? []), ...(next.children ?? [])],
    };
  },
  testLexicalNode: $isTextNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    if (!$isTextNode(lexicalNode)) return;
    const format = lexicalNode.getFormat();
    if (format & ~SUPPORTED_FORMATS) {
      // Underline / sub / super / highlight etc. have no markdown in scope.
      throw new Error(`Unsupported text format bitmask: ${format}`);
    }
    const previousSibling = lexicalNode.getPreviousSibling();
    const prevFormat = $isTextNode(previousSibling) ? previousSibling.getFormat() : 0;
    const text = lexicalNode.getTextContent();

    let parent = mdastParent;
    // First the wrappers this node SHARES with its previous sibling (so the join
    // step can merge them), then the wrappers new to this node. Order is
    // italic → bold → strike, matching MDXEditor, so overlaps nest consistently.
    if (prevFormat & format & IS_ITALIC) {
      parent = actions.appendToParent(parent, { type: "emphasis", children: [] });
    }
    if (prevFormat & format & IS_BOLD) {
      parent = actions.appendToParent(parent, { type: "strong", children: [] });
    }
    if (prevFormat & format & IS_STRIKETHROUGH) {
      parent = actions.appendToParent(parent, { type: "delete", children: [] });
    }
    if (format & IS_ITALIC && !(prevFormat & IS_ITALIC)) {
      parent = actions.appendToParent(parent, { type: "emphasis", children: [] });
    }
    if (format & IS_BOLD && !(prevFormat & IS_BOLD)) {
      parent = actions.appendToParent(parent, { type: "strong", children: [] });
    }
    if (format & IS_STRIKETHROUGH && !(prevFormat & IS_STRIKETHROUGH)) {
      parent = actions.appendToParent(parent, { type: "delete", children: [] });
    }
    if (format & IS_CODE) {
      actions.appendToParent(parent, { type: "inlineCode", value: text });
      return;
    }
    actions.appendToParent(parent, { type: "text", value: text });
  },
};

const VISITORS: LexicalExportVisitor[] = [
  RootVisitor,
  ParagraphVisitor,
  HeadingVisitor,
  QuoteVisitor,
  ListVisitor,
  ListItemVisitor,
  LinkVisitor,
  ImageVisitor,
  LineBreakVisitor,
  HorizontalRuleVisitor,
  UnknownBlockVisitor,
  TextVisitor,
];

function exportLexicalTreeToMdast(root: LexicalNode): Root {
  let unistRoot: MdastNode | null = null;

  function appendToParent(parentNode: MdastNode | null, node: MdastNode): MdastNode {
    if (unistRoot === null) {
      unistRoot = node;
      return unistRoot;
    }
    if (parentNode === null || !isMdastParent(parentNode)) {
      throw new Error("Attempting to append children to a non-parent mdast node");
    }
    const siblings = parentNode.children;
    const prevSibling = siblings.at(-1);
    if (prevSibling) {
      const joiner = VISITORS.find((v) => v.shouldJoin?.(prevSibling, node));
      if (joiner?.join) {
        const joined = joiner.join(prevSibling, node);
        siblings.splice(siblings.length - 1, 1, joined);
        return joined;
      }
    }
    siblings.push(node);
    return node;
  }

  function visitChildren(lexicalNode: ElementNode, parentNode: MdastNode): void {
    lexicalNode.getChildren().forEach((child) => visit(child, parentNode));
  }

  function visit(lexicalNode: LexicalNode, mdastParent: MdastNode | null): void {
    const visitor = VISITORS.find((v) => v.testLexicalNode(lexicalNode));
    if (!visitor) {
      throw new Error(`No export visitor for Lexical node type: ${lexicalNode.getType()}`);
    }
    visitor.visitLexicalNode({
      lexicalNode,
      mdastParent: mdastParent as MdastNode,
      actions: {
        addAndStepInto(type, props = {}, hasChildren = true) {
          const newNode: MdastNode = {
            type,
            ...props,
            ...(hasChildren ? { children: [] } : {}),
          };
          appendToParent(mdastParent, newNode);
          if ($isElementNode(lexicalNode) && hasChildren) {
            visitChildren(lexicalNode, newNode);
          }
        },
        appendToParent,
        visitChildren,
        visit,
      },
    });
  }

  visit(root, null);

  if (unistRoot === null) {
    throw new Error("Export traversal ended with no root node");
  }
  return unistRoot as Root;
}

/**
 * Serialize the current editor content to markdown. Must run inside
 * `editorState.read()` — it reads `$getRoot()`. Throws if the tree contains a
 * Lexical node the bridge can't represent (a code node, an underline format, …).
 */
export function exportMarkdown(): string {
  const tree = exportLexicalTreeToMdast($getRoot());
  return toMarkdown(tree, {
    extensions: TO_MARKDOWN_EXTENSIONS,
    ...TO_MARKDOWN_OPTIONS,
  });
}
