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
  type ElementTransformer,
  type Transformer,
} from "@lexical/markdown";
import {
  $createNodeSelection,
  $setSelection,
  type ElementNode,
  type Klass,
  type LexicalNode,
} from "lexical";

import { UnknownBlockNode } from "./nodes/UnknownBlockNode";
import { ImageNode } from "./nodes/ImageNode";
import {
  $createCodeBlockNode,
  $isCodeBlockNode,
  CodeBlockNode,
  focusCodeBlockOnMount,
} from "./nodes/CodeBlockNode";

// Block + inline nodes the markdown shortcuts (and the bridge) restructure the
// tree into. No `@lexical/code` `CodeNode` — fenced code is our own
// CodeBlockNode (a highlight-free DecoratorNode), never Lexical's code node.
// HorizontalRuleNode backs `---`.
//
// Honest caveat: keeping `@lexical/code`'s CodeNode out of the NODE SET does not
// keep `@lexical/code`/prismjs out of the BUNDLE. `@lexical/markdown` (imported
// above, and again by MarkdownShortcutPlugin) statically imports `@lexical/code`,
// which is sideEffects:true and imports prismjs — so any named import from it
// retains both. Nothing breaks at runtime (prismjs defines its own global; the
// code paths that touch it are never called from our transformer set), but
// deleting @mdxeditor/editor will NOT drop prismjs from the build. Truly escaping
// it means vendoring the shortcut transformers instead of importing
// `@lexical/markdown` — a tracked follow-up, not this file's job.
export const EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  HorizontalRuleNode,
  UnknownBlockNode,
  // Always registered — the bridge imports/exports `image` nodes regardless of
  // whether the runtime handlers (upload/preview) are wired, so a document with
  // images round-trips even in the headless test harness and the sandbox.
  ImageNode,
  // Our fenced-code block. Registered unconditionally for the same reason as
  // ImageNode: the bridge round-trips ```fences``` with no runtime wiring.
  CodeBlockNode,
];

// The ``` shortcut: typing a fence opener followed by a SPACE at the start of a
// paragraph turns it into a code block, optionally capturing a language
// (```ts<space>). This is the trigger the 0.35 MarkdownShortcutPlugin actually
// supports for block transformers — it fires on a trailing space, the same as
// `# ` / `> ` / `- ` (Enter can't drive a block transformer here). We can't reuse
// the built-in CODE transformer: it constructs `@lexical/code`'s CodeNode, which
// we deliberately don't register. `export` is unused in production (serialization
// goes through the bridge, not `$convertToMarkdownString`) but implemented for
// completeness.
const CODE_FENCE_REGEX = /^```([\w#+.-]*) $/;

export const CODE_BLOCK_TRANSFORMER: ElementTransformer = {
  dependencies: [CodeBlockNode],
  export: (node) => {
    if (!$isCodeBlockNode(node)) return null;
    const info = [node.getLanguage(), node.getMeta()].filter(Boolean).join(" ");
    return "```" + info + "\n" + node.getCode() + "\n```";
  },
  regExp: CODE_FENCE_REGEX,
  replace: (parentNode: ElementNode, _children, match, isImport) => {
    const language = match[1] ?? "";
    const node = $createCodeBlockNode("", language, null);
    parentNode.replace(node);
    if (!isImport) {
      // The caret was inside the paragraph we just replaced with a decorator
      // (which can't host a text selection). Leaving the selection pointing at
      // removed nodes makes Lexical throw "selection has been lost" and ROLL
      // BACK the whole transform — the fence stays literal text. Park a
      // NodeSelection on the block (same as Escape does), then hand DOM focus
      // to its textarea once it mounts.
      const selection = $createNodeSelection();
      selection.add(node.getKey());
      $setSelection(selection);
      focusCodeBlockOnMount(node.getKey());
    }
  },
  type: "element",
};

// Explicit transformer set — deliberately NOT the default `TRANSFORMERS` from
// `@lexical/markdown`. That default includes the fenced-code-block transformer,
// which would require registering `CodeNode` and give users a live code editor we
// don't want yet. So we assemble only the block, inline-format, and link
// transformers by hand; code blocks stay out of the editable node set.
//
// Order mirrors the default array's shape: element (block) transformers first,
// then inline text-format transformers, then text-match transformers (LINK).
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
  CODE_BLOCK_TRANSFORMER,
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  ...TEXT_FORMAT_TRANSFORMERS,
  LINK,
];
