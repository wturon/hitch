// Shared test harness: spins up a headless Lexical editor registered with the
// exact node set the Editor Sandbox uses (HeadingNode/QuoteNode/ListNode/
// ListItemNode/LinkNode), then drives the bridge through it. No DOM.
import { createHeadlessEditor } from "@lexical/headless";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $getRoot, type LexicalNode } from "lexical";

import { importMarkdown } from "../importMarkdown";
import { exportMarkdown } from "../exportMarkdown";
import { UnknownBlockNode } from "../../nodes/UnknownBlockNode";
import { ImageNode } from "../../nodes/ImageNode";
import { CodeBlockNode } from "../../nodes/CodeBlockNode";

// Must match SandboxEditor.tsx's `initialConfig.nodes` (the shared EDITOR_NODES).
const NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  HorizontalRuleNode,
  UnknownBlockNode,
  ImageNode,
  CodeBlockNode,
];

function newEditor(onError: (error: Error) => void) {
  return createHeadlessEditor({
    namespace: "hitch-bridge-test",
    nodes: NODES,
    onError,
  });
}

/**
 * Import `markdown`, then export it back out. Any error Lexical routes through
 * `onError` during import is re-thrown so the test sees it. Export errors
 * (thrown inside `read()`) propagate normally.
 */
export function roundTrip(markdown: string): string {
  let importError: unknown;
  const editor = newEditor((error) => {
    importError = error;
  });
  editor.update(() => importMarkdown(markdown), { discrete: true });
  if (importError) throw importError;
  let out = "";
  editor.getEditorState().read(() => {
    out = exportMarkdown();
  });
  return out;
}

/**
 * Import `markdown` and return whatever error it produced (captured via both the
 * editor's `onError` and a direct try/catch, so it doesn't matter whether
 * Lexical swallows or rethrows the update error). Returns `undefined` on success.
 */
export function captureImportError(markdown: string): unknown {
  let captured: unknown;
  const editor = newEditor((error) => {
    captured = error;
  });
  try {
    editor.update(() => importMarkdown(markdown), { discrete: true });
  } catch (error) {
    captured ??= error;
  }
  return captured;
}

/**
 * Import `markdown` and return the `getType()` of every node in the resulting
 * tree (root excluded), depth-first. Lets a test assert e.g. that an unsupported
 * construct landed in an `"unknown-block"` node rather than being dropped.
 */
export function importedNodeTypes(markdown: string): string[] {
  const editor = newEditor((error) => {
    throw error;
  });
  editor.update(() => importMarkdown(markdown), { discrete: true });
  const types: string[] = [];
  editor.getEditorState().read(() => {
    const walk = (node: LexicalNode) => {
      types.push(node.getType());
      const children = (node as { getChildren?: () => LexicalNode[] }).getChildren?.();
      children?.forEach(walk);
    };
    $getRoot()
      .getChildren()
      .forEach(walk);
  });
  return types;
}

/**
 * Build a Lexical tree by hand (inside `editor.update()`), then export it to
 * markdown. Used by the export-side throw tests to construct nodes the import
 * path can't produce (e.g. an underline-formatted TextNode) and assert the
 * serializer fails loudly rather than dropping the unrepresentable formatting.
 */
export function exportBuiltTree(build: () => void): string {
  const editor = newEditor((error) => {
    throw error;
  });
  editor.update(build, { discrete: true });
  let out = "";
  editor.getEditorState().read(() => {
    out = exportMarkdown();
  });
  return out;
}
