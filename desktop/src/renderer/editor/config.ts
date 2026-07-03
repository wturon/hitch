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
// tree into. No `CodeNode` — code blocks are out of scope, and pulling one in
// would drag `@lexical/code`'s Prism global back into the build, the exact
// dependency Text Editor 2.0 exists to escape. HorizontalRuleNode backs `---`;
// UnknownBlockNode preserves any markdown the bridge doesn't model verbatim.
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
// `@lexical/markdown`. That default bundles the fenced-code-block transformer,
// which pulls in `CodeNode`/`CodeHighlightNode` from `@lexical/code` and its
// Prism global. So we assemble only the block, inline-format, and link
// transformers by hand. Code blocks are intentionally out of scope; a fence a
// user pastes survives as an UnknownBlockNode via the bridge, not a live editor.
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
