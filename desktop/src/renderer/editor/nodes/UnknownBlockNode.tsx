// An opaque, byte-preserving fallback block. When `importMarkdown` meets a
// top-level construct the bridge doesn't model (a code fence, table, raw HTML,
// image paragraph, a list with a loose item, …), it stores the ORIGINAL
// markdown source of that block here, verbatim, instead of throwing or lossily
// re-rendering it. Export emits the stored bytes back out untouched.
//
// This is the linchpin of the round-trip guarantee for unsupported markdown:
// the `.md` file is the interface agents grep, so a block we can't edit must
// still survive a load→save with zero byte churn. The node is deliberately
// read-only in the UI — you can select/delete it as a unit, but not edit its
// text (editing an opaque slice has no lossless mapping back to markdown).
//
// This is the one file under `editor/` that is a React *component* living
// outside a `plugins/` folder; the `bridge/` folder stays React-free and
// imports only this node's class + factory (no JSX).
import type {
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical";
import { DecoratorNode } from "lexical";
import type { ReactElement } from "react";

// The serialized shape carries the one field we store: the raw markdown source.
export type SerializedUnknownBlockNode = Spread<
  { source: string },
  SerializedLexicalNode
>;

export class UnknownBlockNode extends DecoratorNode<ReactElement> {
  /** Raw markdown source of the block, byte-exact as sliced from the input. */
  readonly __source: string;

  static getType(): string {
    return "unknown-block";
  }

  static clone(node: UnknownBlockNode): UnknownBlockNode {
    return new UnknownBlockNode(node.__source, node.__key);
  }

  static importJSON(serialized: SerializedUnknownBlockNode): UnknownBlockNode {
    return $createUnknownBlockNode(serialized.source);
  }

  constructor(source: string, key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  exportJSON(): SerializedUnknownBlockNode {
    return {
      ...super.exportJSON(),
      type: UnknownBlockNode.getType(),
      version: 1,
      source: this.__source,
    };
  }

  /** The stored source is the node's text content (used by copy/serialize). */
  getSource(): string {
    return this.__source;
  }

  getTextContent(): string {
    return this.__source;
  }

  // Lexical needs a host element; the visible block is rendered by `decorate`.
  createDOM(): HTMLElement {
    return document.createElement("div");
  }

  // The node is immutable (source is set once at construction), so the DOM host
  // never needs reconciling — Lexical re-renders the decorator when needed.
  updateDOM(): false {
    return false;
  }

  isInline(): false {
    return false;
  }

  decorate(): ReactElement {
    // Read-only presentation: monospace, muted, whitespace-preserved, with a
    // small label so it's clear this is an unsupported construct kept verbatim.
    // Tokens mirror the app's Tailwind palette (see SandboxEditor.tsx).
    return (
      <div className="my-2 overflow-x-auto rounded-md border border-border bg-secondary px-3 py-2">
        <div className="mb-1 select-none font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          unsupported markdown
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-muted-foreground">
          {this.__source}
        </pre>
      </div>
    );
  }
}

export function $createUnknownBlockNode(source: string): UnknownBlockNode {
  return new UnknownBlockNode(source);
}

export function $isUnknownBlockNode(
  node: LexicalNode | null | undefined,
): node is UnknownBlockNode {
  return node instanceof UnknownBlockNode;
}
