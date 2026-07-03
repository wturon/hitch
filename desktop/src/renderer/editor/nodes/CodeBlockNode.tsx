// A Notion-style fenced code block: a block-level DecoratorNode backing a plain
// markdown fence (```lang … ```). Deliberately highlight-free — plain monospace
// text in a rounded, theme-token container with a quiet language dropdown in the
// top-right. No `@lexical/code`/prismjs anywhere: syntax highlighting is out of
// scope by product decision, so nothing here pulls that machinery in.
//
// Unlike ImageNode/UnknownBlockNode (immutable, set once at construction) this
// node is MUTABLE: the textarea inside the decorator writes back through
// `setCode`, and the language dropdown through `setLanguage`. Both go through
// `getWritable()`, so edits participate in Lexical's reconciliation/history and
// flow out through ControlledMarkdownPlugin as markdown per keystroke — the same
// cost as typing anywhere else.
//
// The three fields fully capture a markdown `code` node: `__code` is the fence
// body, `__language` the info-string language (`""` = a lang-less fence), and
// `__meta` the rest of the info string after the language (`title=x`, `{1,3}`,
// …) preserved verbatim for round-trip and never surfaced in the UI.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $createParagraphNode,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import type {
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { mergeRegister } from "@lexical/utils";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The curated language menu, in display order. The empty value is "Plain text"
// (a lang-less fence). A document may carry a language outside this list (any
// info string is legal markdown); the dropdown surfaces that raw value as an
// extra option rather than destroying it — see `CodeBlockComponent`.
const LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Plain text" },
  { value: "ts", label: "ts" },
  { value: "tsx", label: "tsx" },
  { value: "js", label: "js" },
  { value: "jsx", label: "jsx" },
  { value: "python", label: "python" },
  { value: "bash", label: "bash" },
  { value: "json", label: "json" },
  { value: "yaml", label: "yaml" },
  { value: "sql", label: "sql" },
  { value: "html", label: "html" },
  { value: "css", label: "css" },
  { value: "rust", label: "rust" },
  { value: "go", label: "go" },
  { value: "markdown", label: "markdown" },
];

// A freshly-inserted block (via the slash menu or the ``` shortcut) records its
// key here so the decorator can focus its textarea once, on mount. A single
// module-level string — not a registry — so there is nothing to leak; the
// component reads-and-clears it, and a stale key simply never matches.
let pendingFocusKey: NodeKey | null = null;

/** Mark a code block to auto-focus its textarea when its decorator next mounts. */
export function focusCodeBlockOnMount(key: NodeKey): void {
  pendingFocusKey = key;
}

export type SerializedCodeBlockNode = Spread<
  { code: string; language: string; meta: string | null },
  SerializedLexicalNode
>;

export class CodeBlockNode extends DecoratorNode<ReactElement> {
  __code: string;
  __language: string;
  __meta: string | null;

  static getType(): string {
    return "code-block";
  }

  static clone(node: CodeBlockNode): CodeBlockNode {
    return new CodeBlockNode(
      node.__code,
      node.__language,
      node.__meta,
      node.__key,
    );
  }

  static importJSON(serialized: SerializedCodeBlockNode): CodeBlockNode {
    return $createCodeBlockNode(
      serialized.code,
      serialized.language,
      serialized.meta,
    );
  }

  constructor(
    code: string,
    language: string,
    meta: string | null,
    key?: NodeKey,
  ) {
    super(key);
    this.__code = code;
    this.__language = language;
    this.__meta = meta;
  }

  exportJSON(): SerializedCodeBlockNode {
    return {
      ...super.exportJSON(),
      type: CodeBlockNode.getType(),
      version: 1,
      code: this.__code,
      language: this.__language,
      meta: this.__meta,
    };
  }

  getCode(): string {
    return this.getLatest().__code;
  }

  getLanguage(): string {
    return this.getLatest().__language;
  }

  getMeta(): string | null {
    return this.getLatest().__meta;
  }

  // Mutable setters: the textarea and the language dropdown are the two edit
  // surfaces. Both must run inside an `editor.update()` (getWritable() enforces
  // it) so the change reconciles and re-serializes like any other edit.
  setCode(code: string): void {
    this.getWritable().__code = code;
  }

  setLanguage(language: string): void {
    this.getWritable().__language = language;
  }

  // The stored code is the node's text content (copy/serialize surfaces).
  getTextContent(): string {
    return this.getLatest().__code;
  }

  // Lexical needs a host element; the visible block is rendered by `decorate`.
  // The `data-editor-block-type` attribute mirrors ImageNode so e2e/context
  // tooling can target the block.
  createDOM(): HTMLElement {
    const div = document.createElement("div");
    div.setAttribute("data-editor-block-type", "code");
    return div;
  }

  // React owns everything inside the decorator; the host div never reconciles.
  updateDOM(): false {
    return false;
  }

  isInline(): false {
    return false;
  }

  decorate(): ReactElement {
    return (
      <CodeBlockComponent
        code={this.__code}
        language={this.__language}
        nodeKey={this.getKey()}
      />
    );
  }
}

export function $createCodeBlockNode(
  code: string,
  language: string,
  meta: string | null,
): CodeBlockNode {
  return new CodeBlockNode(code, language, meta);
}

export function $isCodeBlockNode(
  node: LexicalNode | null | undefined,
): node is CodeBlockNode {
  return node instanceof CodeBlockNode;
}

function CodeBlockComponent({
  code,
  language,
  nodeKey,
}: {
  code: string;
  language: string;
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelected] =
    useLexicalNodeSelection(nodeKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Local mirror of the code: the textarea is the source of truth while focused,
  // so it can't be driven straight off the `code` prop (a Lexical update commits
  // asynchronously, and a controlled value that snaps back to the pre-commit
  // string on the same tick fights the caret). We update this synchronously on
  // input and push to the node in the same handler; the node→local sync below
  // only fires for an EXTERNAL change (adoption), where `code` and `text` differ.
  const [text, setText] = useState(code);
  useEffect(() => {
    if (code !== text) setText(code);
    // Intentionally keyed on `code` only: a local edit sets `text` first and
    // then advances `code` to the same string, so this no-ops; a genuine
    // external `code` change (differs from what the user has) adopts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Auto-focus a freshly-inserted block once (slash menu / ``` shortcut).
  useEffect(() => {
    if (pendingFocusKey === nodeKey) {
      pendingFocusKey = null;
      textareaRef.current?.focus();
    }
  }, [nodeKey]);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      setText(next);
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isCodeBlockNode(node)) node.setCode(next);
      });
    },
    [editor, nodeKey],
  );

  const onLanguageChange = useCallback(
    (value: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isCodeBlockNode(node)) node.setLanguage(value);
      });
    },
    [editor, nodeKey],
  );

  // Node-select this block and move keyboard focus to Lexical, so the block can
  // be deleted (Backspace/Delete handlers below) or navigated as a unit.
  const nodeSelect = useCallback(() => {
    textareaRef.current?.blur();
    clearSelected();
    setSelected(true);
    editor.focus();
  }, [clearSelected, setSelected, editor]);

  // Move the Lexical caret out of the block to an adjacent sibling, creating a
  // trailing paragraph when the block is the last node (mirrors SlashMenuPlugin's
  // insertDivider guarantee — inserting at the very end can otherwise strand the
  // selection with nowhere to type).
  const escapeTo = useCallback(
    (direction: "up" | "down") => {
      textareaRef.current?.blur();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isCodeBlockNode(node)) return;
        if (direction === "down") {
          let after = node.getNextSibling();
          if (after === null) {
            after = $createParagraphNode();
            node.insertAfter(after);
          }
          after.selectStart();
        } else {
          const before = node.getPreviousSibling();
          if (before !== null) {
            before.selectEnd();
          } else {
            const paragraph = $createParagraphNode();
            node.insertBefore(paragraph);
            paragraph.selectStart();
          }
        }
      });
      editor.focus();
    },
    [editor, nodeKey],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        nodeSelect();
        return;
      }
      const el = event.currentTarget;
      const { selectionStart, selectionEnd, value } = el;
      const collapsed = selectionStart === selectionEnd;
      // Undo/redo must have a single authority. Focus is in a native textarea,
      // so ⌘Z would otherwise trigger BOTH the textarea's own undo stack and
      // Lexical's history (the keydown still bubbles to the editor root) — two
      // systems reverting different state out from under each other. Kill the
      // native edit, stop the bubble, and route to Lexical's history, which
      // holds every setCode commit; the node→local adoption sync above then
      // brings the textarea along.
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const redo = event.key.toLowerCase() === "y" || event.shiftKey;
        editor.dispatchCommand(redo ? REDO_COMMAND : UNDO_COMMAND, undefined);
        return;
      }
      // Tab indents (two spaces) instead of tabbing focus out — nobody reaches
      // for Tab inside a code block hoping to land on the language dropdown.
      // Shift+Tab keeps its native reverse-focus meaning as the keyboard exit.
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        el.setRangeText("  ", selectionStart, selectionEnd, "end");
        const next = el.value;
        setText(next);
        editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if ($isCodeBlockNode(node)) node.setCode(next);
        });
        return;
      }
      if (event.key === "ArrowDown" && collapsed) {
        // On the last line → step out below.
        if (value.indexOf("\n", selectionEnd) === -1) {
          event.preventDefault();
          event.stopPropagation();
          escapeTo("down");
          return;
        }
      }
      if (event.key === "ArrowUp" && collapsed) {
        // On the first line → step out above.
        if (value.lastIndexOf("\n", selectionStart - 1) === -1) {
          event.preventDefault();
          event.stopPropagation();
          escapeTo("up");
          return;
        }
      }
      // Let app-global shortcuts (⌘K, …) through; contain every other key
      // so Lexical's own bindings (Backspace-deletes-block, Enter, arrows, Tab,
      // the `/` slash menu) never act on the surrounding document while the user
      // is typing code. The textarea sits inside a contentEditable=false host, so
      // this is belt-and-braces, but keydown still bubbles to the editor root.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.stopPropagation();
    },
    [nodeSelect, escapeTo, editor, nodeKey],
  );

  // Backspace/Delete on the node-selected block removes it — the same explicit
  // NodeSelection pattern ImageNode uses (Lexical's default RichText handlers
  // don't reliably delete a block decorator under a NodeSelection).
  useEffect(() => {
    const onDelete = (event: KeyboardEvent) => {
      if (!isSelected || !$isNodeSelection($getSelection())) return false;
      event.preventDefault();
      const node = $getNodeByKey(nodeKey);
      if ($isCodeBlockNode(node)) node.remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(KEY_BACKSPACE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_DELETE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
    );
  }, [editor, isSelected, nodeKey]);

  // Surface an out-of-list language as its own option so changing it never
  // destroys a value the document already carries.
  const known = LANGUAGE_OPTIONS.some((option) => option.value === language);
  const options = known
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, { value: language, label: language }];

  return (
    <div
      className={cn(
        "group relative my-2 rounded-lg border border-border bg-muted",
        isSelected && "ring-2 ring-ring",
      )}
    >
      {/* Language dropdown, top-right. Quiet by default (ghost, muted) so it
          doesn't compete with the code, but always present — a touch more
          visible on hover. Focus-stealing is fine: it's an explicit click, not a
          typing interaction. */}
      <div className="absolute right-1.5 top-1.5 z-10 opacity-60 transition-opacity group-hover:opacity-100">
        <Select
          value={language}
          onValueChange={(value) => onLanguageChange(value as string)}
        >
          <SelectTrigger className="h-6 border-transparent bg-transparent px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-background hover:text-foreground">
            <SelectValue>
              {options.find((option) => option.value === language)?.label ??
                "Plain text"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="end" className="min-w-[9rem]">
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                className="font-mono text-[12px]"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFocus={() => clearSelected()}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={1}
        aria-label="Code block"
        // `field-sizing: content` auto-grows the textarea to its content in the
        // bundled Chromium (Electron 42, Chromium ≥136) — the cleanest sizer, no
        // hidden mirror element. `rows={1}` sets the minimum height.
        style={{ fieldSizing: "content" } as React.CSSProperties}
        className="block w-full resize-none border-0 bg-transparent px-3 py-2.5 pr-16 font-mono text-[13px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
