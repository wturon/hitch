// The `/` slash-command menu for the Hitch editor — a Notion-style block picker
// that turns the current block into a heading/list/quote or drops in a divider,
// without the user reaching for markdown syntax. Above the block commands it also
// offers a "Skills" section (the agent skills installed on the machine, fed in as
// a prop) so users can autocomplete a `/skill-name` mention into the text as
// PLAIN TEXT — no custom node, no serialization change — and, above that, a
// "Snippets" section (the user's saved snippets, also fed in as a prop) whose
// selection REPLACES the `/query` with the snippet's whole markdown body.
// Snippets and skills render before the block commands because they're used
// more often than the block transforms.
//
// Behavior is NOT ours: it rides `LexicalTypeaheadMenuPlugin`, which owns the
// trigger detection, the query string, keyboard nav (↑/↓ wrap, Enter/Tab select,
// Esc dismiss), and a caret-anchored, viewport-flipping popover element. We own
// only the pixels (the dropdown we portal into that anchor) and the actions each
// option runs. That split is deliberate: a Radix/Base-UI menu would grab focus
// and fight the contenteditable for the keyboard — the typeahead plugin keeps
// focus in the editor and drives the menu through Lexical commands instead.
//
// The list of commands (`SLASH_COMMANDS`) and the query filter
// (`filterSlashCommands`) are exported as pure data/functions so they can be
// unit-tested without a DOM; the plugin component itself stays internal
// (MarkdownEditor / the sandbox compose it — see index.ts, which does NOT
// re-export it).
import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import { $insertNodeToNearestRoot } from "@lexical/utils";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $insertNodes,
  $isParagraphNode,
  $isRangeSelection,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import {
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  SquareCodeIcon,
  TextQuoteIcon,
  type LucideProps,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { $importMarkdownFragment } from "./bridge";
import {
  $createCodeBlockNode,
  focusCodeBlockOnMount,
} from "./nodes/CodeBlockNode";

// One slash command: what the menu shows and what it does when chosen. `run`
// executes INSIDE an active `editor.update` (`applySlashCommand` opens one before
// calling us), so it can freely use `$`-prefixed helpers and command dispatch
// against the current selection.
export interface SlashCommandSpec {
  key: string;
  title: string;
  icon: ComponentType<LucideProps>;
  // Kept lowercase so filtering is a plain `includes` with no per-keystroke
  // case folding of the (fixed) keyword set.
  keywords: string[];
  run: (editor: LexicalEditor) => void;
}

// One installed skill offered in the menu. Shaped by the app layer
// (hooks/useSkills.ts) and passed into `MarkdownEditor` as a prop — the editor
// stays Convex-free and knows nothing about where these come from. `harnesses`
// is the set of agents the skill is installed for (e.g. "claude-code", "codex"),
// rendered as small badges on the row's right edge.
export interface SkillMenuItem {
  name: string;
  description?: string;
  harnesses: ReadonlyArray<string>;
}

// One saved snippet offered in the menu. Shaped by the app layer
// (hooks/useSnippets.ts) and passed into `MarkdownEditor` as a prop — same
// Convex-free contract as `SkillMenuItem`. `body` is the snippet's full
// markdown, inserted verbatim in place of the `/query` when chosen (see
// `runSnippetInsert` — unlike a skill, no `/name` reference is left behind).
export interface SnippetMenuItem {
  name: string;
  body: string;
}

// Retarget the block(s) touched by the current selection to a fresh element of
// the given kind. This is exactly how `@lexical/markdown`'s HEADING/QUOTE
// transformers restructure a paragraph — `$setBlocksType` preserves the block's
// existing inline content, so any text left after the `/query` is stripped
// survives (e.g. "some text /h1" → an H1 still reading "some text").
function transformBlock(create: () => ElementNode): void {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    $setBlocksType(selection, create);
  }
}

// v1 command set — exactly these, in menu order. No speculative entries.
export const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    key: "h1",
    title: "Heading 1",
    icon: Heading1Icon,
    keywords: ["h1", "title"],
    run: () => transformBlock(() => $createHeadingNode("h1")),
  },
  {
    key: "h2",
    title: "Heading 2",
    icon: Heading2Icon,
    keywords: ["h2", "subtitle"],
    run: () => transformBlock(() => $createHeadingNode("h2")),
  },
  {
    key: "h3",
    title: "Heading 3",
    icon: Heading3Icon,
    keywords: ["h3"],
    run: () => transformBlock(() => $createHeadingNode("h3")),
  },
  {
    key: "ul",
    title: "Bullet list",
    icon: ListIcon,
    keywords: ["ul", "unordered"],
    // The list COMMAND (not `$setBlocksType`) so ListPlugin's own logic builds
    // the ListNode/ListItemNode shape and handles an already-list block; dispatch
    // inside the surrounding update runs its handler synchronously.
    run: (editor) => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
  },
  {
    key: "ol",
    title: "Numbered list",
    icon: ListOrderedIcon,
    keywords: ["ol", "ordered"],
    run: (editor) => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
  },
  {
    key: "quote",
    title: "Quote",
    icon: TextQuoteIcon,
    keywords: ["blockquote"],
    run: () => transformBlock(() => $createQuoteNode()),
  },
  {
    key: "code",
    title: "Code block",
    icon: SquareCodeIcon,
    keywords: ["code", "codeblock", "fence", "snippet"],
    run: insertCodeBlock,
  },
  {
    key: "hr",
    title: "Divider",
    icon: MinusIcon,
    keywords: ["hr", "rule", "line", "separator"],
    run: insertDivider,
  },
];

// Drop an empty code block after the current block and focus its textarea. Same
// guaranteed-trailing-paragraph shape as `insertDivider` (a block decorator at
// the very end of the document would otherwise leave the caret nowhere useful),
// then hand focus to the new block's textarea on mount via `focusCodeBlockOnMount`.
function insertCodeBlock(): void {
  const node = $insertNodeToNearestRoot($createCodeBlockNode("", "", null));
  if (!$isParagraphNode(node.getNextSibling())) {
    node.insertAfter($createParagraphNode());
  }
  focusCodeBlockOnMount(node.getKey());
}

// Drop a horizontal rule after the current block. `$insertNodeToNearestRoot` is
// what INSERT_HORIZONTAL_RULE_COMMAND (HorizontalRulePlugin) calls; we invoke it
// directly so the action works even where that plugin isn't mounted (the action
// unit tests), then guarantee a plain paragraph after the rule and park the caret
// there — inserting at the very end of the document can otherwise leave the
// selection on the (non-text) rule node with nowhere to type.
function insertDivider(): void {
  const rule = $insertNodeToNearestRoot($createHorizontalRuleNode());
  let after = rule.getNextSibling();
  if (!$isParagraphNode(after)) {
    after = $createParagraphNode();
    rule.insertAfter(after);
  }
  after.selectStart();
}

// Pure query → visible-commands filter (exported for unit tests). Case-insensitive
// substring against title and keywords; an empty/whitespace query shows the full
// set. Zero matches returns `[]`, which the plugin renders as nothing — so the
// menu visually closes and the typed `/query` is left as plain text.
export function filterSlashCommands(
  query: string,
  commands: SlashCommandSpec[] = SLASH_COMMANDS,
): SlashCommandSpec[] {
  const q = query.trim().toLowerCase();
  if (q === "") return commands;
  return commands.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.includes(q)),
  );
}

// Pure query → visible-skills filter (exported for unit tests). Mirrors
// `filterSlashCommands`: case-insensitive substring, empty query shows all. Only
// the skill name is matched (there are no keywords to fold), so behavior lines up
// with the block commands the user is filtering in the same keystroke.
export function filterSkills(
  query: string,
  skills: ReadonlyArray<SkillMenuItem>,
): SkillMenuItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...skills];
  return skills.filter((s) => s.name.toLowerCase().includes(q));
}

// Pure query → visible-snippets filter (exported for unit tests). Identical
// matching semantics to `filterSkills`: case-insensitive substring against the
// name only, empty query shows all, zero matches returns `[]`.
export function filterSnippets(
  query: string,
  snippets: ReadonlyArray<SnippetMenuItem>,
): SnippetMenuItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...snippets];
  return snippets.filter((s) => s.name.toLowerCase().includes(q));
}

// One-line body preview for a snippet row (exported for unit tests): the first
// non-blank line with its whitespace collapsed, single-line truncated by the
// row's CSS — the snippet-section counterpart of a skill's description.
export function snippetBodyPreview(body: string): string {
  const firstLine = body.trimStart().split("\n", 1)[0] ?? "";
  return firstLine.replace(/\s+/g, " ").trim();
}

// The core of choosing a command: remove the `/query` text node the typeahead
// split off, then run the action. MUST be called inside an active `editor.update`
// — the typeahead opens one before invoking `onSelectOption`, and reusing it (not
// nesting a fresh update) is load-bearing: a nested update would run against a
// not-yet-committed split, leaving the trigger `/` behind.
function runSlashCommand(
  editor: LexicalEditor,
  spec: SlashCommandSpec,
  nodeToRemove: TextNode | null,
): void {
  nodeToRemove?.remove();
  spec.run(editor);
}

// Test-only convenience: `runSlashCommand` wrapped in its own update, so the
// action tests can drive the exact production path from outside an update.
export function applySlashCommand(
  editor: LexicalEditor,
  spec: SlashCommandSpec,
  nodeToRemove: TextNode | null,
): void {
  editor.update(() => runSlashCommand(editor, spec, nodeToRemove));
}

// Choosing a skill: unlike a block command, this doesn't transform the block — it
// replaces the split-off `/query` node with plain text `/name ` (trailing space)
// so the mention stays byte-plain markdown with no custom node. Same in-place-
// update contract as `runSlashCommand`. When there's no split node (defensive —
// the typeahead always provides one), fall back to inserting at the selection.
function runSkillInsert(
  editor: LexicalEditor,
  skill: SkillMenuItem,
  nodeToRemove: TextNode | null,
): void {
  const text = `/${skill.name} `;
  if (nodeToRemove) {
    const replacement = $createTextNode(text);
    nodeToRemove.replace(replacement);
    replacement.selectEnd();
    return;
  }
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertText(text);
  }
}

// Test-only convenience: `runSkillInsert` wrapped in its own update, mirroring
// `applySlashCommand`.
export function applySkillInsert(
  editor: LexicalEditor,
  skill: SkillMenuItem,
  nodeToRemove: TextNode | null,
): void {
  editor.update(() => runSkillInsert(editor, skill, nodeToRemove));
}

// Choosing a snippet: unlike a skill (which leaves a plain-text `/name`
// reference), this REPLACES the `/query` with the snippet's whole markdown
// body, parsed through the bridge's fragment importer:
//   - a single-paragraph body flows INLINE into the current paragraph (its
//     children stand in for the token — no block split, no extra characters),
//   - a multi-block body is inserted as blocks at the token's position, and
//     `RangeSelection.insertNodes` owns the split: it divides the current
//     paragraph at the caret, merges mergeable edges (paste semantics), and
//     removes the current block when the token was its only content — so no
//     stray empty paragraph survives where the `/` was typed.
// Either way `insertNodes` parks the caret at the end of the inserted content.
// Same in-place-update contract as `runSlashCommand`; the fragment importer
// also requires an active update and its nodes are attached in the same one.
function runSnippetInsert(
  editor: LexicalEditor,
  snippet: SnippetMenuItem,
  nodeToRemove: TextNode | null,
): void {
  const fragment = $importMarkdownFragment(snippet.body);
  // A single-paragraph body inserts its INLINE children; anything else inserts
  // the top-level blocks themselves.
  const only = fragment.length === 1 ? fragment[0] : null;
  const nodes =
    only !== null && $isParagraphNode(only) ? only.getChildren() : fragment;
  if (nodes.length === 0) {
    // Bodies are validated non-empty, so this is defensive-only: still remove
    // the token so no half-typed `/query` is left behind.
    nodeToRemove?.remove();
    return;
  }
  if (nodeToRemove) {
    // Park the selection over the whole token: `insertNodes` removes a
    // non-collapsed selection's text first, so this deletes the `/query` and
    // targets the insertion at where it stood, in one motion.
    nodeToRemove.select(0, nodeToRemove.getTextContentSize());
  }
  $insertNodes(nodes);
}

// Test-only convenience: `runSnippetInsert` wrapped in its own update,
// mirroring `applySkillInsert`.
export function applySnippetInsert(
  editor: LexicalEditor,
  snippet: SnippetMenuItem,
  nodeToRemove: TextNode | null,
): void {
  editor.update(() => runSnippetInsert(editor, snippet, nodeToRemove));
}

// The typeahead `MenuOption` (its key + ref bookkeeping) paired with our command
// spec. A fresh set is minted per query so the plugin re-indexes highlight state.
class SlashMenuOption extends MenuOption {
  constructor(readonly spec: SlashCommandSpec) {
    super(spec.key);
  }
}

// The skill-section twin of `SlashMenuOption`. Key is namespaced so it can never
// collide with a block command's key when both sets share the typeahead's flat
// option list.
class SkillMenuOption extends MenuOption {
  constructor(readonly skill: SkillMenuItem) {
    super(`skill:${skill.name}`);
  }
}

// The snippet-section twin. Same namespacing rationale as `SkillMenuOption`.
class SnippetMenuOption extends MenuOption {
  constructor(readonly snippet: SnippetMenuItem) {
    super(`snippet:${snippet.name}`);
  }
}

// All sections share the typeahead's single option array (keyboard nav flows
// across them as one list); the split into snippet/skill/command options is
// only a rendering concern. Built pure so unit tests can assert section
// membership without a DOM: an empty snippets/skills list → empty options →
// the plugin renders no section for it (zero behavior change from before each
// feature).
export function buildSlashMenuSections(
  query: string,
  skills: ReadonlyArray<SkillMenuItem>,
  snippets: ReadonlyArray<SnippetMenuItem>,
): {
  commandOptions: SlashMenuOption[];
  skillOptions: SkillMenuOption[];
  snippetOptions: SnippetMenuOption[];
} {
  return {
    commandOptions: filterSlashCommands(query).map(
      (spec) => new SlashMenuOption(spec),
    ),
    skillOptions: filterSkills(query, skills).map(
      (skill) => new SkillMenuOption(skill),
    ),
    snippetOptions: filterSnippets(query, snippets).map(
      (snippet) => new SnippetMenuOption(snippet),
    ),
  };
}

// Two-letter monochrome glyph per harness for the row's badges. Kept as quiet
// text (not the app's colored harness SVGs) so the menu stays monochrome and the
// editor owns no app assets — see the file header on the ownership split.
const HARNESS_BADGE_LABELS: Record<string, string> = {
  "claude-code": "CC",
  codex: "CX",
};

function harnessBadgeLabel(harness: string): string {
  return HARNESS_BADGE_LABELS[harness] ?? harness.slice(0, 2).toUpperCase();
}

// The union the typeahead nav treats as one flat list; rendering splits it back
// into its three sections.
type SlashOption = SlashMenuOption | SkillMenuOption | SnippetMenuOption;

// One clickable row, shared by all sections. `globalIndex` is the option's
// position in the typeahead's flat list (snippets, then skills, then block
// commands), so keyboard highlight and mouse highlight agree across the section
// boundaries. `stacked` switches the row from the block commands' single line
// (icon + title, centered) to the snippet/skill rows' two lines (name, then
// preview/description) — see `SlashMenuList` for what each section passes as
// `children`.
function SlashMenuRow({
  globalIndex,
  selectedIndex,
  setRefElement,
  selectOption,
  setHighlightedIndex,
  stacked = false,
  children,
}: {
  globalIndex: number;
  selectedIndex: number | null;
  setRefElement: (el: HTMLElement | null) => void;
  selectOption: () => void;
  setHighlightedIndex: (index: number) => void;
  stacked?: boolean;
  children: ReactNode;
}) {
  const active = globalIndex === selectedIndex;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      ref={(el) => setRefElement(el)}
      // Keep the click from blurring the editor / collapsing the selection
      // before `onClick` fires — the caret must stay put for the transform,
      // so focus never leaves the contenteditable.
      onMouseDown={(e) => e.preventDefault()}
      onClick={selectOption}
      // Highlight on mouse MOVEMENT, not enter: the menu opens under the
      // stationary cursor, and Chromium re-hit-tests on layout change —
      // an onMouseEnter would steal the keyboard preselection (row 0)
      // without the user touching the mouse. cmdk does the same.
      onMouseMove={() => {
        if (globalIndex !== selectedIndex) setHighlightedIndex(globalIndex);
      }}
      className={cn(
        "flex w-full min-w-0 gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        stacked ? "flex-col" : "items-center",
        active ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// The dropdown itself — shadcn popover skin over the app's semantic tokens (so it
// reads correctly in light and dark without hardcoded colors), NOT a shadcn/Radix
// component: the typeahead plugin owns focus and keyboard, this only paints rows.
// The "Snippets" section (name + dimmed one-line body preview) renders FIRST,
// then "Skills" (name + dimmed description + monochrome harness badges), then
// the block commands — matching the flat option order the keyboard navigates.
export function SlashMenuList({
  commandOptions,
  skillOptions,
  snippetOptions,
  selectedIndex,
  selectOption,
  setHighlightedIndex,
}: {
  commandOptions: SlashMenuOption[];
  skillOptions: SkillMenuOption[];
  snippetOptions: SnippetMenuOption[];
  selectedIndex: number | null;
  selectOption: (option: SlashOption) => void;
  setHighlightedIndex: (index: number) => void;
}) {
  return (
    // `w-max` (width: max-content) is load-bearing, not decorative: the
    // typeahead's anchor <div> (this element's positioned parent) is sized to
    // the tiny caret rect, not to our content, and a plain block box's
    // `width: auto` fills its *containing block* rather than sizing to its own
    // content — so without `w-max` this would sit pinned at `min-w-[300px]`
    // for every row, and `max-w-[400px]` would never have a chance to matter.
    // `w-max` makes the box content-sized (shrink/grow-to-fit), and `min-w`/
    // `max-w` then clamp that to the [300, 400] range a long skill name needs.
    <div className="max-h-[min(320px,60vh)] w-max min-w-[300px] max-w-[400px] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
      {snippetOptions.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Snippets
          </div>
          {snippetOptions.map((option, i) => {
            // Snippets occupy the very front of the flat typeahead list.
            const globalIndex = i;
            const active = globalIndex === selectedIndex;
            const { name, body } = option.snippet;
            const preview = snippetBodyPreview(body);
            return (
              <SlashMenuRow
                key={option.key}
                globalIndex={globalIndex}
                selectedIndex={selectedIndex}
                setRefElement={(el) => option.setRefElement(el)}
                selectOption={() => selectOption(option)}
                setHighlightedIndex={setHighlightedIndex}
                stacked
              >
                {/* Line 1: the snippet name — same type treatment as a skill
                    name, minus the leading `/` (choosing one inserts the BODY,
                    not a `/name` reference). */}
                <span className="block w-full min-w-0 truncate">{name}</span>
                {/* Line 2: the dimmed one-line body preview, ellipsized — the
                    same slot a skill row gives its description. */}
                {preview ? (
                  <span
                    className={cn(
                      "block w-full truncate text-[12px]",
                      active
                        ? "text-accent-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {preview}
                  </span>
                ) : null}
              </SlashMenuRow>
            );
          })}
        </>
      )}

      {skillOptions.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Skills
          </div>
          {skillOptions.map((option, i) => {
            // Offset by the snippets ahead of this section in the flat list.
            const globalIndex = snippetOptions.length + i;
            const active = globalIndex === selectedIndex;
            const { name, description, harnesses } = option.skill;
            return (
              <SlashMenuRow
                key={option.key}
                globalIndex={globalIndex}
                selectedIndex={selectedIndex}
                setRefElement={(el) => option.setRefElement(el)}
                selectOption={() => selectOption(option)}
                setHighlightedIndex={setHighlightedIndex}
                stacked
              >
                {/* Line 1: the skill name, truncating only once the badges have
                    claimed their fixed width (name is `flex-1 min-w-0`, badges
                    are `shrink-0`) — badges stay right-aligned and never wrap. */}
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">/{name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {harnesses.map((harness) => (
                      <span
                        key={harness}
                        className="rounded border border-border px-1 text-[10px] font-medium leading-4 text-muted-foreground"
                      >
                        {harnessBadgeLabel(harness)}
                      </span>
                    ))}
                  </span>
                </span>
                {/* Line 2: the dimmed description, full width, single-line
                    truncated — never competes with the name for space. */}
                {description ? (
                  <span
                    className={cn(
                      "block w-full truncate text-[12px]",
                      active
                        ? "text-accent-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {description}
                  </span>
                ) : null}
              </SlashMenuRow>
            );
          })}
        </>
      )}

      {commandOptions.map((option, j) => {
        // Offset by both leading sections: snippets then skills occupy the
        // front of the flat typeahead list, so a block command's global index
        // (used for keyboard/mouse highlight, see `SlashMenuRow`) starts
        // counting after them, not from 0.
        const globalIndex = snippetOptions.length + skillOptions.length + j;
        const Icon = option.spec.icon;
        const active = globalIndex === selectedIndex;
        return (
          <SlashMenuRow
            key={option.key}
            globalIndex={globalIndex}
            selectedIndex={selectedIndex}
            setRefElement={(el) => option.setRefElement(el)}
            selectOption={() => selectOption(option)}
            setHighlightedIndex={setHighlightedIndex}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                active ? "text-accent-foreground" : "text-muted-foreground",
              )}
            />
            <span className="truncate">{option.spec.title}</span>
          </SlashMenuRow>
        );
      })}
    </div>
  );
}

// Hand-transcribed twin of `useBasicTypeaheadTriggerMatch("/", { minLength: 0,
// maxLength: 40 })` (@lexical/react/LexicalTypeaheadMenuPlugin.dev.mjs) — see the
// deviation below. Upstream builds a NEGATED valid-query-character class,
// `[^<trigger><PUNCTUATION>\s]` (exclude the trigger char, a fixed punctuation
// set, and whitespace), and matches `(^|\s|\()(<trigger>(<validChars>{0,40}))$`
// against the text up to the caret. Our skills are kebab-case (`be-concise`),
// and upstream's punctuation set includes `-`, so the query stops matching at
// the very first hyphen and the whole menu closes mid-word. We change ONLY the
// valid-query-character class, to a POSITIVE class of exactly what a query can
// contain — word chars plus hyphen (`[A-Za-z0-9_-]`) — since spaces are outside
// that class either way, the menu still closes on a space. The lead conditions
// (start of block / after whitespace / after `(`), `minLength: 0`, and
// `maxLength: 40` are transcribed unchanged; they're baked in as constants
// rather than left parameterized since this file only ever calls it one way.
const SLASH_TRIGGER_MIN_LENGTH = 0;
const SLASH_TRIGGER_MAX_LENGTH = 40;
const SLASH_TRIGGER_REGEX = new RegExp(
  `(^|\\s|\\()(/((?:[A-Za-z0-9_-]){0,${SLASH_TRIGGER_MAX_LENGTH}}))$`,
);

// Exported (like `filterSlashCommands`/`filterSkills`) so it can be unit-tested
// directly as a pure string → match function, without a DOM or a real editor.
export function slashTriggerMatch(
  text: string,
): { leadOffset: number; matchingString: string; replaceableString: string } | null {
  const match = SLASH_TRIGGER_REGEX.exec(text);
  if (match !== null) {
    const maybeLeadingWhitespace = match[1];
    const matchingString = match[3];
    if (matchingString.length >= SLASH_TRIGGER_MIN_LENGTH) {
      return {
        leadOffset: match.index + maybeLeadingWhitespace.length,
        matchingString,
        replaceableString: match[2],
      };
    }
  }
  return null;
}

export function SlashMenuPlugin({
  skills = EMPTY_SKILLS,
  snippets = EMPTY_SNIPPETS,
}: {
  // The installed skills to offer above the block commands. Omitted / empty →
  // no Skills section, identical behavior to before this feature.
  skills?: ReadonlyArray<SkillMenuItem>;
  // The user's snippets to offer above the skills. Same contract: omitted /
  // empty → no Snippets section, zero behavior change.
  snippets?: ReadonlyArray<SnippetMenuItem>;
}) {
  const [editor] = useLexicalComposerContext();
  // The live query (text after `/`); `null` when the menu is closed.
  const [query, setQuery] = useState<string | null>(null);

  // Trigger on `/` at the start of a block or after whitespace (the regex's
  // `(^|\s|\()` prefix), matching up to 40 query chars through hyphens and
  // underscores (kebab-case skill names), stopping at a space. `minLength: 0`
  // so a bare `/` opens the full menu before any filter text is typed. See
  // `slashTriggerMatch`'s own comment for how/why this deviates from upstream's
  // `useBasicTypeaheadTriggerMatch`. A plain module-level function (not a hook)
  // — it has no dependencies to track, so it's passed straight through instead
  // of re-wrapped in a `useCallback`.
  const triggerFn = slashTriggerMatch;

  // Three sections, one flat option list for the typeahead. Snippets come
  // FIRST, then skills, then the block commands, so keyboard nav (↑/↓/Enter,
  // which the plugin drives off this array's order) reads
  // snippets-then-skills-then-block-commands, matching the render order.
  // Behavior note: with snippets present, a bare `/` + Enter now selects the
  // first SNIPPET (previously the first skill) — intended, same "used more
  // often" rationale that put skills ahead of the block transforms.
  const { commandOptions, skillOptions, snippetOptions, options } =
    useMemo(() => {
      const sections = buildSlashMenuSections(query ?? "", skills, snippets);
      return {
        ...sections,
        options: [
          ...sections.snippetOptions,
          ...sections.skillOptions,
          ...sections.commandOptions,
        ],
      };
    }, [query, skills, snippets]);

  const onSelectOption = useCallback(
    (
      option: SlashOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
    ) => {
      // Already inside the `editor.update` the typeahead opened around this
      // callback (right after splitting off `nodeToRemove`) — mutate directly.
      // Nesting another `editor.update` here would queue it behind this one and
      // strand the split query node (see runSlashCommand's contract).
      if (option instanceof SnippetMenuOption) {
        runSnippetInsert(editor, option.snippet, nodeToRemove);
      } else if (option instanceof SkillMenuOption) {
        runSkillInsert(editor, option.skill, nodeToRemove);
      } else {
        runSlashCommand(editor, option.spec, nodeToRemove);
      }
      closeMenu();
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<SlashOption>
      options={options}
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      // The typeahead plugin owns this anchor element (a bare `<div>` it
      // appends to `document.body` and portals our menu into) — we never
      // create or style a wrapper ourselves. Left unstyled it paints at
      // z-index:auto, which loses to the TaskDialog's `z-50` Base UI overlay
      // (dialog.tsx) whenever `/` is typed inside the dialog: the menu opens
      // but is invisible behind the modal. `anchorClassName` is the typeahead
      // API's own hook for styling that element, so this is a z-index change
      // only — same tier as LinkPopoverPlugin's `z-[90]` (the editor's other
      // document.body-portaled floating layer), no new wrapper, no portal
      // retarget, so it can't intercept the dialog's own backdrop-press
      // dismissal.
      anchorClassName="z-[90]"
      menuRenderFn={(
        anchorElementRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) =>
        // No matches → render nothing (menu appears closed, `/query` stays as
        // typed text). The anchor element is created before the first paint, so
        // guard against a null ref too.
        anchorElementRef.current == null || options.length === 0
          ? null
          : createPortal(
              <SlashMenuList
                commandOptions={commandOptions}
                skillOptions={skillOptions}
                snippetOptions={snippetOptions}
                selectedIndex={selectedIndex}
                selectOption={selectOptionAndCleanUp}
                setHighlightedIndex={setHighlightedIndex}
              />,
              anchorElementRef.current,
            )
      }
    />
  );
}

// Stable identities for the defaults so `SlashMenuPlugin`'s sections memo
// doesn't re-run every render when a parent omits the props.
const EMPTY_SKILLS: ReadonlyArray<SkillMenuItem> = [];
const EMPTY_SNIPPETS: ReadonlyArray<SnippetMenuItem> = [];
