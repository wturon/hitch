/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// Vendored from @lexical/markdown@0.35.0 (packages/lexical-markdown/src/
// MarkdownTransformers.ts). Only the transformers this editor actually uses are
// copied: HEADING, QUOTE, UNORDERED_LIST, ORDERED_LIST, LINK, and the inline
// TEXT_FORMAT_TRANSFORMERS, plus their private helpers. The point of vendoring
// is to NOT import @lexical/markdown (it statically imports @lexical/code →
// prismjs, which then can't leave the bundle). We deliberately do NOT vendor the
// CODE (multiline) transformer — our fenced code is CodeBlockNode, a highlight-
// free DecoratorNode (see ../config.ts's CODE_BLOCK_TRANSFORMER) — which is the
// only reason @lexical/code was reachable. Logic is byte-for-byte the installed
// 0.35.0; only TypeScript annotations were added over the untyped .dev.mjs.
import {
  $createLineBreakNode,
  $createTextNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import {
  $isListNode,
  $isListItemNode,
  ListNode,
  ListItemNode,
  $createListItemNode,
  $createListNode,
  type ListType,
} from "@lexical/list";
import {
  $isQuoteNode,
  HeadingNode,
  $isHeadingNode,
  QuoteNode,
  $createQuoteNode,
  $createHeadingNode,
} from "@lexical/rich-text";
import {
  LinkNode,
  $isLinkNode,
  $isAutoLinkNode,
  $createLinkNode,
} from "@lexical/link";

import type {
  ElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
} from "./types";

const ORDERED_LIST_REGEX = /^(\s*)(\d{1,})\.\s/;
const UNORDERED_LIST_REGEX = /^(\s*)[-*+]\s/;
const HEADING_REGEX = /^(#{1,6})\s/;
const QUOTE_REGEX = /^>\s/;

const createBlockNode = (
  createNode: (match: Array<string>) => ElementNode,
): ElementTransformer["replace"] => {
  return (parentNode, children, match, isImport) => {
    const node = createNode(match);
    node.append(...children);
    parentNode.replace(node);
    if (!isImport) {
      node.select(0, 0);
    }
  };
};

// Amount of spaces that define indentation level
// TODO: should be an option
const LIST_INDENT_SIZE = 4;

function getIndent(whitespaces: string): number {
  const tabs = whitespaces.match(/\t/g);
  const spaces = whitespaces.match(/ /g);
  let indent = 0;
  if (tabs) {
    indent += tabs.length;
  }
  if (spaces) {
    indent += Math.floor(spaces.length / LIST_INDENT_SIZE);
  }
  return indent;
}

const listReplace = (listType: ListType): ElementTransformer["replace"] => {
  return (parentNode, children, match, isImport) => {
    const previousNode = parentNode.getPreviousSibling();
    const nextNode = parentNode.getNextSibling();
    const listItem = $createListItemNode(
      listType === "check" ? match[3] === "x" : undefined,
    );
    if ($isListNode(nextNode) && nextNode.getListType() === listType) {
      const firstChild = nextNode.getFirstChild();
      if (firstChild !== null) {
        firstChild.insertBefore(listItem);
      } else {
        // should never happen, but let's handle gracefully, just in case.
        nextNode.append(listItem);
      }
      parentNode.remove();
    } else if (
      $isListNode(previousNode) &&
      previousNode.getListType() === listType
    ) {
      previousNode.append(listItem);
      parentNode.remove();
    } else {
      const list = $createListNode(
        listType,
        listType === "number" ? Number(match[2]) : undefined,
      );
      list.append(listItem);
      parentNode.replace(list);
    }
    listItem.append(...children);
    if (!isImport) {
      listItem.select(0, 0);
    }
    const indent = getIndent(match[1]);
    if (indent) {
      listItem.setIndent(indent);
    }
  };
};

const listExport = (
  listNode: ListNode,
  exportChildren: (node: ElementNode) => string,
  depth: number,
): string => {
  const output = [];
  const children = listNode.getChildren();
  let index = 0;
  for (const listItemNode of children) {
    if ($isListItemNode(listItemNode)) {
      if (listItemNode.getChildrenSize() === 1) {
        const firstChild = listItemNode.getFirstChild();
        if ($isListNode(firstChild)) {
          output.push(listExport(firstChild, exportChildren, depth + 1));
          continue;
        }
      }
      const indent = " ".repeat(depth * LIST_INDENT_SIZE);
      const listType = listNode.getListType();
      const prefix =
        listType === "number"
          ? `${listNode.getStart() + index}. `
          : listType === "check"
            ? `- [${listItemNode.getChecked() ? "x" : " "}] `
            : "- ";
      output.push(indent + prefix + exportChildren(listItemNode));
      index++;
    }
  }
  return output.join("\n");
};

export const HEADING: ElementTransformer = {
  dependencies: [HeadingNode],
  export: (node, exportChildren) => {
    if (!$isHeadingNode(node)) {
      return null;
    }
    const level = Number(node.getTag().slice(1));
    return "#".repeat(level) + " " + exportChildren(node);
  },
  regExp: HEADING_REGEX,
  replace: createBlockNode((match) => {
    const tag = ("h" + match[1].length) as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return $createHeadingNode(tag);
  }),
  type: "element",
};

export const QUOTE: ElementTransformer = {
  dependencies: [QuoteNode],
  export: (node, exportChildren) => {
    if (!$isQuoteNode(node)) {
      return null;
    }
    const lines = exportChildren(node).split("\n");
    const output = [];
    for (const line of lines) {
      output.push("> " + line);
    }
    return output.join("\n");
  },
  regExp: QUOTE_REGEX,
  replace: (parentNode, children, _match, isImport) => {
    if (isImport) {
      const previousNode = parentNode.getPreviousSibling();
      if ($isQuoteNode(previousNode)) {
        previousNode.splice(previousNode.getChildrenSize(), 0, [
          $createLineBreakNode(),
          ...children,
        ]);
        parentNode.remove();
        return;
      }
    }
    const node = $createQuoteNode();
    node.append(...children);
    parentNode.replace(node);
    if (!isImport) {
      node.select(0, 0);
    }
  },
  type: "element",
};

export const UNORDERED_LIST: ElementTransformer = {
  dependencies: [ListNode, ListItemNode],
  export: (node, exportChildren) => {
    return $isListNode(node) ? listExport(node, exportChildren, 0) : null;
  },
  regExp: UNORDERED_LIST_REGEX,
  replace: listReplace("bullet"),
  type: "element",
};

export const ORDERED_LIST: ElementTransformer = {
  dependencies: [ListNode, ListItemNode],
  export: (node, exportChildren) => {
    return $isListNode(node) ? listExport(node, exportChildren, 0) : null;
  },
  regExp: ORDERED_LIST_REGEX,
  replace: listReplace("number"),
  type: "element",
};

const INLINE_CODE: TextFormatTransformer = {
  format: ["code"],
  tag: "`",
  type: "text-format",
};

const HIGHLIGHT: TextFormatTransformer = {
  format: ["highlight"],
  tag: "==",
  type: "text-format",
};

const BOLD_ITALIC_STAR: TextFormatTransformer = {
  format: ["bold", "italic"],
  tag: "***",
  type: "text-format",
};

const BOLD_ITALIC_UNDERSCORE: TextFormatTransformer = {
  format: ["bold", "italic"],
  intraword: false,
  tag: "___",
  type: "text-format",
};

const BOLD_STAR: TextFormatTransformer = {
  format: ["bold"],
  tag: "**",
  type: "text-format",
};

const BOLD_UNDERSCORE: TextFormatTransformer = {
  format: ["bold"],
  intraword: false,
  tag: "__",
  type: "text-format",
};

const STRIKETHROUGH: TextFormatTransformer = {
  format: ["strikethrough"],
  tag: "~~",
  type: "text-format",
};

const ITALIC_STAR: TextFormatTransformer = {
  format: ["italic"],
  tag: "*",
  type: "text-format",
};

const ITALIC_UNDERSCORE: TextFormatTransformer = {
  format: ["italic"],
  intraword: false,
  tag: "_",
  type: "text-format",
};

// Order of text transformers matters:
//
// - code should go first as it prevents any transformations inside
// - then longer tags match (e.g. ** or __ should go before * or _)
export const LINK: TextMatchTransformer = {
  dependencies: [LinkNode],
  export: (node, exportChildren) => {
    if (!$isLinkNode(node) || $isAutoLinkNode(node)) {
      return null;
    }
    const title = node.getTitle();
    const textContent = exportChildren(node);
    const linkContent = title
      ? `[${textContent}](${node.getURL()} "${title}")`
      : `[${textContent}](${node.getURL()})`;
    return linkContent;
  },
  importRegExp:
    /(?:\[(.*?)\])(?:\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\))/,
  regExp:
    /(?:\[(.*?)\])(?:\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\))$/,
  replace: (textNode, match) => {
    const [, linkText, linkUrl, linkTitle] = match;
    const linkNode = $createLinkNode(linkUrl, { title: linkTitle });
    const openBracketAmount = linkText.split("[").length - 1;
    const closeBracketAmount = linkText.split("]").length - 1;
    let parsedLinkText = linkText;
    let outsideLinkText = "";
    if (openBracketAmount < closeBracketAmount) {
      return;
    } else if (openBracketAmount > closeBracketAmount) {
      const linkTextParts = linkText.split("[");
      outsideLinkText = "[" + linkTextParts[0];
      parsedLinkText = linkTextParts.slice(1).join("[");
    }
    const linkTextNode = $createTextNode(parsedLinkText);
    linkTextNode.setFormat(textNode.getFormat());
    linkNode.append(linkTextNode);
    textNode.replace(linkNode);
    if (outsideLinkText) {
      linkNode.insertBefore($createTextNode(outsideLinkText));
    }
    return linkTextNode;
  },
  trigger: ")",
  type: "text-match",
};

// Order of text format transformers matters:
//
// - code should go first as it prevents any transformations inside
// - then longer tags match (e.g. ** or __ should go before * or _)
export const TEXT_FORMAT_TRANSFORMERS: Array<TextFormatTransformer> = [
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HIGHLIGHT,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
];
