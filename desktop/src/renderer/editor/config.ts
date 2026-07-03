// Shared Lexical configuration for the Hitch editor — the node set and the
// markdown-shortcut transformer list, in one place so the vanilla sandbox and
// the production `MarkdownEditor` can't drift apart. Both build a
// `LexicalComposer` from exactly these, and the bridge test harness registers
// the same nodes headlessly (see bridge/__tests__/harness.ts).
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import {
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  LINK,
  TEXT_FORMAT_TRANSFORMERS,
  type Transformer,
} from "@lexical/markdown";
import type { Klass, LexicalNode } from "lexical";

import { UnknownBlockNode } from "./nodes/UnknownBlockNode";

// Block + inline nodes the markdown shortcuts (and the bridge) restructure the
// tree into. No `CodeNode` — code blocks are out of scope, so no code node ever
// appears in a document (a pasted fence survives as an UnknownBlockNode via the
// bridge). HorizontalRuleNode backs `---`.
//
// Honest caveat: keeping CodeNode out of the NODE SET does not keep
// `@lexical/code`/prismjs out of the BUNDLE. `@lexical/markdown` (imported above,
// and again by MarkdownShortcutPlugin) statically imports `@lexical/code`, which
// is sideEffects:true and imports prismjs — so any named import from it retains
// both. Nothing breaks at runtime (prismjs defines its own global; the code paths
// that touch it are never called from our transformer set), but deleting
// @mdxeditor/editor will NOT drop prismjs from the build. Truly escaping it means
// vendoring the shortcut transformers instead of importing `@lexical/markdown` —
// a tracked follow-up, not this file's job.
export const EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  HorizontalRuleNode,
  UnknownBlockNode,
];

// Explicit transformer set — deliberately NOT the default `TRANSFORMERS` from
// `@lexical/markdown`. That default includes the fenced-code-block transformer,
// which would require registering `CodeNode` and give users a live code editor we
// don't want yet. So we assemble only the block, inline-format, and link
// transformers by hand; code blocks stay out of the editable node set.
//
// Order mirrors the default array's shape: element (block) transformers first,
// then inline text-format transformers, then text-match transformers (LINK).
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  ...TEXT_FORMAT_TRANSFORMERS,
  LINK,
];
