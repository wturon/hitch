/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// Vendored from @lexical/markdown@0.35.0 — the typing-shortcut engine:
// registerMarkdownShortcuts and its private helpers (transformersByType,
// indexBy, the punctuation regex, the run*/$run* transformer drivers). We copy
// it here instead of importing @lexical/markdown because that package statically
// imports @lexical/code (sideEffects:true), which imports prismjs — so any
// import from @lexical/markdown, even of the shortcut engine that never touches
// a CodeNode, retains prismjs in the production bundle. Vendoring this file (plus
// ./transformers.ts and ./types.ts) is what finally drops @lexical/code/prismjs.
//
// Logic is byte-for-byte the installed 0.35.0 (LexicalMarkdown.dev.mjs); only
// TypeScript annotations were added over the untyped source, plus ONE behavior-
// preserving change: the `$isCodeNode(parentNode)` bail (see registerMarkdown-
// Shortcuts below) is dropped, because we never register @lexical/code's CodeNode
// and that guard can never fire in our editor. Do NOT re-import @lexical/markdown
// or @lexical/code here — that would defeat the entire vendoring.
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $isLineBreakNode,
  $isRootOrShadowRoot,
  $createRangeSelection,
  $setSelection,
  COLLABORATION_TAG,
  HISTORIC_TAG,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from "lexical";

import type {
  ElementTransformer,
  MultilineElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
  Transformer,
} from "./types";

function indexBy<T>(
  list: Array<T>,
  callback: (item: T) => string | null | undefined,
): Readonly<Record<string, Array<T>>> {
  const index: Record<string, Array<T>> = {};
  for (const item of list) {
    const key = callback(item);
    if (!key) {
      continue;
    }
    if (index[key]) {
      index[key].push(item);
    } else {
      index[key] = [item];
    }
  }
  return index;
}

function transformersByType(transformers: Array<Transformer>): {
  element: Array<ElementTransformer>;
  multilineElement: Array<MultilineElementTransformer>;
  textFormat: Array<TextFormatTransformer>;
  textMatch: Array<TextMatchTransformer>;
} {
  const byType = indexBy(transformers, (t) => t.type);
  return {
    element: (byType.element || []) as Array<ElementTransformer>,
    multilineElement: (byType["multiline-element"] ||
      []) as Array<MultilineElementTransformer>,
    textFormat: (byType["text-format"] || []) as Array<TextFormatTransformer>,
    textMatch: (byType["text-match"] || []) as Array<TextMatchTransformer>,
  };
}

const PUNCTUATION_OR_SPACE = /[!-/:-@[-`{-~\s]/;

/**
 * Returns true if the node can contain transformable markdown.
 * Code nodes cannot contain transformable markdown.
 * For example, `code **bold**` should not be transformed to
 * <code>code <strong>bold</strong></code>.
 */
function canContainTransformableMarkdown(
  node: LexicalNode | null | undefined,
): node is TextNode {
  return $isTextNode(node) && !node.hasFormat("code");
}

// Do not require this module directly! Use normal `invariant` calls.
function formatDevErrorMessage(message: string): never {
  throw new Error(message);
}

function runElementTransformers(
  parentNode: ElementNode,
  anchorNode: TextNode,
  anchorOffset: number,
  elementTransformers: Array<ElementTransformer>,
): boolean {
  const grandParentNode = parentNode.getParent();
  if (
    !$isRootOrShadowRoot(grandParentNode) ||
    parentNode.getFirstChild() !== anchorNode
  ) {
    return false;
  }
  const textContent = anchorNode.getTextContent();

  // Checking for anchorOffset position to prevent any checks for cases when caret is too far
  // from a line start to be a part of block-level markdown trigger.
  //
  // TODO:
  // Can have a quick check if caret is close enough to the beginning of the string (e.g. offset less than 10-20)
  // since otherwise it won't be a markdown shortcut, but tables are exception
  if (textContent[anchorOffset - 1] !== " ") {
    return false;
  }
  for (const { regExp, replace } of elementTransformers) {
    const match = textContent.match(regExp);
    if (
      match &&
      match[0].length === (match[0].endsWith(" ") ? anchorOffset : anchorOffset - 1)
    ) {
      const nextSiblings = anchorNode.getNextSiblings();
      const [leadingNode, remainderNode] = anchorNode.splitText(anchorOffset);
      const siblings = remainderNode
        ? [remainderNode, ...nextSiblings]
        : nextSiblings;
      if (replace(parentNode, siblings, match, false) !== false) {
        leadingNode.remove();
        return true;
      }
    }
  }
  return false;
}

function runMultilineElementTransformers(
  parentNode: ElementNode,
  anchorNode: TextNode,
  anchorOffset: number,
  elementTransformers: Array<MultilineElementTransformer>,
): boolean {
  const grandParentNode = parentNode.getParent();
  if (
    !$isRootOrShadowRoot(grandParentNode) ||
    parentNode.getFirstChild() !== anchorNode
  ) {
    return false;
  }
  const textContent = anchorNode.getTextContent();

  // Checking for anchorOffset position to prevent any checks for cases when caret is too far
  // from a line start to be a part of block-level markdown trigger.
  //
  // TODO:
  // Can have a quick check if caret is close enough to the beginning of the string (e.g. offset less than 10-20)
  // since otherwise it won't be a markdown shortcut, but tables are exception
  if (textContent[anchorOffset - 1] !== " ") {
    return false;
  }
  for (const { regExpStart, replace, regExpEnd } of elementTransformers) {
    if (
      (regExpEnd && !("optional" in regExpEnd)) ||
      (regExpEnd && "optional" in regExpEnd && !regExpEnd.optional)
    ) {
      continue;
    }
    const match = textContent.match(regExpStart);
    if (
      match &&
      match[0].length === (match[0].endsWith(" ") ? anchorOffset : anchorOffset - 1)
    ) {
      const nextSiblings = anchorNode.getNextSiblings();
      const [leadingNode, remainderNode] = anchorNode.splitText(anchorOffset);
      const siblings = remainderNode
        ? [remainderNode, ...nextSiblings]
        : nextSiblings;
      if (replace(parentNode, siblings, match, null, null, false) !== false) {
        leadingNode.remove();
        return true;
      }
    }
  }
  return false;
}

function runTextMatchTransformers(
  anchorNode: TextNode,
  anchorOffset: number,
  transformersByTrigger: Readonly<Record<string, Array<TextMatchTransformer>>>,
): boolean {
  let textContent = anchorNode.getTextContent();
  const lastChar = textContent[anchorOffset - 1];
  const transformers = transformersByTrigger[lastChar];
  if (transformers == null) {
    return false;
  }

  // If typing in the middle of content, remove the tail to do
  // reg exp match up to a string end (caret position)
  if (anchorOffset < textContent.length) {
    textContent = textContent.slice(0, anchorOffset);
  }
  for (const transformer of transformers) {
    if (!transformer.replace || !transformer.regExp) {
      continue;
    }
    const match = textContent.match(transformer.regExp);
    if (match === null) {
      continue;
    }
    const startIndex = match.index || 0;
    const endIndex = startIndex + match[0].length;
    let replaceNode: TextNode;
    if (startIndex === 0) {
      [replaceNode] = anchorNode.splitText(endIndex);
    } else {
      [, replaceNode] = anchorNode.splitText(startIndex, endIndex);
    }
    replaceNode.selectNext(0, 0);
    transformer.replace(replaceNode, match);
    return true;
  }
  return false;
}

function $runTextFormatTransformers(
  anchorNode: TextNode,
  anchorOffset: number,
  textFormatTransformers: Readonly<
    Record<string, Array<TextFormatTransformer>>
  >,
): boolean {
  const textContent = anchorNode.getTextContent();
  const closeTagEndIndex = anchorOffset - 1;
  const closeChar = textContent[closeTagEndIndex];
  // Quick check if we're possibly at the end of inline markdown style
  const matchers = textFormatTransformers[closeChar];
  if (!matchers) {
    return false;
  }
  for (const matcher of matchers) {
    const { tag } = matcher;
    const tagLength = tag.length;
    const closeTagStartIndex = closeTagEndIndex - tagLength + 1;

    // If tag is not single char check if rest of it matches with text content
    if (tagLength > 1) {
      if (!isEqualSubString(textContent, closeTagStartIndex, tag, 0, tagLength)) {
        continue;
      }
    }

    // Space before closing tag cancels inline markdown
    if (textContent[closeTagStartIndex - 1] === " ") {
      continue;
    }

    // Some tags can not be used within words, hence should have newline/space/punctuation after it
    const afterCloseTagChar = textContent[closeTagEndIndex + 1];
    if (
      matcher.intraword === false &&
      afterCloseTagChar &&
      !PUNCTUATION_OR_SPACE.test(afterCloseTagChar)
    ) {
      continue;
    }
    const closeNode = anchorNode;
    let openNode = closeNode;
    let openTagStartIndex = getOpenTagStartIndex(
      textContent,
      closeTagStartIndex,
      tag,
    );

    // Go through text node siblings and search for opening tag
    // if haven't found it within the same text node as closing tag
    let sibling: LexicalNode | null = openNode;
    while (openTagStartIndex < 0 && (sibling = sibling.getPreviousSibling())) {
      if ($isLineBreakNode(sibling)) {
        break;
      }
      if ($isTextNode(sibling)) {
        if (sibling.hasFormat("code")) {
          continue;
        }
        const siblingTextContent = sibling.getTextContent();
        openNode = sibling;
        openTagStartIndex = getOpenTagStartIndex(
          siblingTextContent,
          siblingTextContent.length,
          tag,
        );
      }
    }

    // Opening tag is not found
    if (openTagStartIndex < 0) {
      continue;
    }

    // No content between opening and closing tag
    if (
      openNode === closeNode &&
      openTagStartIndex + tagLength === closeTagStartIndex
    ) {
      continue;
    }

    // Checking longer tags for repeating chars (e.g. *** vs **)
    const prevOpenNodeText = openNode.getTextContent();
    if (
      openTagStartIndex > 0 &&
      prevOpenNodeText[openTagStartIndex - 1] === closeChar
    ) {
      continue;
    }

    // Some tags can not be used within words, hence should have newline/space/punctuation before it
    const beforeOpenTagChar = prevOpenNodeText[openTagStartIndex - 1];
    if (
      matcher.intraword === false &&
      beforeOpenTagChar &&
      !PUNCTUATION_OR_SPACE.test(beforeOpenTagChar)
    ) {
      continue;
    }

    // Clean text from opening and closing tags (starting from closing tag
    // to prevent any offset shifts if we start from opening one)
    const prevCloseNodeText = closeNode.getTextContent();
    const closeNodeText =
      prevCloseNodeText.slice(0, closeTagStartIndex) +
      prevCloseNodeText.slice(closeTagEndIndex + 1);
    closeNode.setTextContent(closeNodeText);
    const openNodeText =
      openNode === closeNode ? closeNodeText : prevOpenNodeText;
    openNode.setTextContent(
      openNodeText.slice(0, openTagStartIndex) +
        openNodeText.slice(openTagStartIndex + tagLength),
    );
    const selection = $getSelection();
    const nextSelection = $createRangeSelection();
    $setSelection(nextSelection);
    // Adjust offset based on deleted chars
    const newOffset =
      closeTagEndIndex - tagLength * (openNode === closeNode ? 2 : 1) + 1;
    nextSelection.anchor.set(openNode.__key, openTagStartIndex, "text");
    nextSelection.focus.set(closeNode.__key, newOffset, "text");

    // Apply formatting to selected text
    for (const format of matcher.format) {
      if (!nextSelection.hasFormat(format)) {
        nextSelection.formatText(format);
      }
    }

    // Collapse selection up to the focus point
    nextSelection.anchor.set(
      nextSelection.focus.key,
      nextSelection.focus.offset,
      nextSelection.focus.type,
    );

    // Remove formatting from collapsed selection
    for (const format of matcher.format) {
      if (nextSelection.hasFormat(format)) {
        nextSelection.toggleFormat(format);
      }
    }
    if ($isRangeSelection(selection)) {
      nextSelection.format = selection.format;
    }
    return true;
  }
  return false;
}

function getOpenTagStartIndex(
  string: string,
  maxIndex: number,
  tag: string,
): number {
  const tagLength = tag.length;
  for (let i = maxIndex; i >= tagLength; i--) {
    const startIndex = i - tagLength;
    if (
      isEqualSubString(string, startIndex, tag, 0, tagLength) &&
      // Space after opening tag cancels transformation
      string[startIndex + tagLength] !== " "
    ) {
      return startIndex;
    }
  }
  return -1;
}

function isEqualSubString(
  stringA: string,
  aStart: number,
  stringB: string,
  bStart: number,
  length: number,
): boolean {
  for (let i = 0; i < length; i++) {
    if (stringA[aStart + i] !== stringB[bStart + i]) {
      return false;
    }
  }
  return true;
}

export function registerMarkdownShortcuts(
  editor: LexicalEditor,
  transformers: Array<Transformer>,
): () => void {
  const byType = transformersByType(transformers);
  const textFormatTransformersByTrigger = indexBy(
    byType.textFormat,
    ({ tag }) => tag[tag.length - 1],
  );
  const textMatchTransformersByTrigger = indexBy(
    byType.textMatch,
    ({ trigger }) => trigger,
  );
  for (const transformer of transformers) {
    const type = transformer.type;
    if (
      type === "element" ||
      type === "text-match" ||
      type === "multiline-element"
    ) {
      const dependencies = transformer.dependencies;
      for (const node of dependencies) {
        if (!editor.hasNode(node)) {
          formatDevErrorMessage(
            `MarkdownShortcuts: missing dependency ${node.getType()} for transformer. Ensure node dependency is included in editor initial config.`,
          );
        }
      }
    }
  }
  const $transform = (
    parentNode: ElementNode,
    anchorNode: TextNode,
    anchorOffset: number,
  ) => {
    if (
      runElementTransformers(parentNode, anchorNode, anchorOffset, byType.element)
    ) {
      return;
    }
    if (
      runMultilineElementTransformers(
        parentNode,
        anchorNode,
        anchorOffset,
        byType.multilineElement,
      )
    ) {
      return;
    }
    if (
      runTextMatchTransformers(
        anchorNode,
        anchorOffset,
        textMatchTransformersByTrigger,
      )
    ) {
      return;
    }
    $runTextFormatTransformers(
      anchorNode,
      anchorOffset,
      textFormatTransformersByTrigger,
    );
  };
  return editor.registerUpdateListener(
    ({ tags, dirtyLeaves, editorState, prevEditorState }) => {
      // Ignore updates from collaboration and undo/redo (as changes already calculated)
      if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) {
        return;
      }

      // If editor is still composing (i.e. backticks) we must wait before the user confirms the key
      if (editor.isComposing()) {
        return;
      }
      const selection = editorState.read($getSelection);
      const prevSelection = prevEditorState.read($getSelection);

      // We expect selection to be a collapsed range and not match previous one (as we want
      // to trigger transforms only as user types)
      if (
        !$isRangeSelection(prevSelection) ||
        !$isRangeSelection(selection) ||
        !selection.isCollapsed() ||
        selection.is(prevSelection)
      ) {
        return;
      }
      const anchorKey = selection.anchor.key;
      const anchorOffset = selection.anchor.offset;
      const anchorNode = editorState._nodeMap.get(anchorKey);
      if (
        !$isTextNode(anchorNode) ||
        !dirtyLeaves.has(anchorKey) ||
        (anchorOffset !== 1 && anchorOffset > prevSelection.anchor.offset + 1)
      ) {
        return;
      }
      editor.update(() => {
        if (!canContainTransformableMarkdown(anchorNode)) {
          return;
        }
        const parentNode = anchorNode.getParent();
        // Upstream also bails here when parentNode is @lexical/code's CodeNode
        // (markdown shortcuts must never run inside a code block). We never
        // register that node — our fenced code is CodeBlockNode, a DecoratorNode
        // that cannot host a RangeSelection — so anchorNode (a TextNode holding
        // the caret) can never have a CodeNode as its parent. The `$isCodeNode`
        // disjunct is therefore vacuously false, and dropping it lets us avoid
        // importing @lexical/code (whose static prismjs import this file exists
        // to escape). No behavioral difference for any document our editor can
        // produce.
        if (parentNode === null) {
          return;
        }
        $transform(parentNode, anchorNode, selection.anchor.offset);
      });
    },
  );
}
