// markdown string → detached Lexical nodes, for inserting a fragment (e.g. a
// snippet body) at the caret WITHOUT touching the root. Same fidelity contract
// as `importMarkdown`: every top-level construct either becomes editable
// Lexical nodes (when the visitors can represent its whole subtree, plus the
// byte-exact gate for top-level fences) or is preserved verbatim in an
// `UnknownBlockNode`. Nothing is dropped or lossily re-rendered.
import { $createParagraphNode, type LexicalNode } from "lexical";

import { $importMarkdownInto } from "./importMarkdown";

/**
 * Parse `markdown` and return the resulting top-level Lexical nodes as an
 * array, without reading or mutating `$getRoot()`. Empty / whitespace-only
 * input returns `[]` (it parses to a root with no flow children).
 *
 * Must run inside `editor.update()` — it creates nodes. The caller MUST insert
 * the returned nodes into the tree within that same update: Lexical
 * garbage-collects nodes left unattached when the update reconciles, so a
 * fragment that is imported but never inserted simply evaporates (which is
 * also why the scratch container below needs no explicit cleanup).
 *
 * Detached-container note: the visitors build nodes by APPENDING into a parent
 * (`visit(node, parent, format)`), so a fragment import needs some ElementNode
 * to collect into. Lexical has no generic "just an element" factory and its
 * RootNode is a per-editor singleton, so we use a scratch ParagraphNode that is
 * never attached. It only ever receives `append()` calls — the one visitor that
 * needs a sibling relationship (ListVisitor's nested-list `insertAfter`) always
 * targets a ListItemNode created *inside* the fragment, never the container
 * itself — and block children inside a paragraph are never reconciled or
 * exported because the container is discarded, not returned. The returned nodes
 * are still parented to the scratch container; any Lexical insertion
 * (`append`, `insertAfter`, `$insertNodes`, …) re-parents them automatically.
 */
export function $importMarkdownFragment(markdown: string): LexicalNode[] {
  const scratch = $createParagraphNode();
  $importMarkdownInto(markdown, scratch);
  return scratch.getChildren();
}
