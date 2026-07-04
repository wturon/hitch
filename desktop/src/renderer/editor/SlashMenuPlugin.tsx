// The `/` slash-command menu for the Hitch editor — a Notion-style block picker
// that turns the current block into a heading/list/quote or drops in a divider,
// without the user reaching for markdown syntax. Below the block commands it also
// offers a "Skills" section (the agent skills installed on the machine, fed in as
// a prop) so users can autocomplete a `/skill-name` mention into the text as
// PLAIN TEXT — no custom node, no serialization change.
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
  useBasicTypeaheadTriggerMatch,
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

// Both sections share the typeahead's single option array (keyboard nav flows
// across them as one list); the split into command/skill options is only a
// rendering concern. Built pure so unit tests can assert section membership
// without a DOM: no skills → empty `skillOptions` → the plugin renders no Skills
// section (zero behavior change from before this feature).
export function buildSlashMenuSections(
  query: string,
  skills: ReadonlyArray<SkillMenuItem>,
): { commandOptions: SlashMenuOption[]; skillOptions: SkillMenuOption[] } {
  return {
    commandOptions: filterSlashCommands(query).map(
      (spec) => new SlashMenuOption(spec),
    ),
    skillOptions: filterSkills(query, skills).map(
      (skill) => new SkillMenuOption(skill),
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
// into its two sections.
type SlashOption = SlashMenuOption | SkillMenuOption;

// One clickable row, shared by both sections. `globalIndex` is the option's
// position in the typeahead's flat list (block commands first, then skills), so
// keyboard highlight and mouse highlight agree across the section boundary.
function SlashMenuRow({
  globalIndex,
  selectedIndex,
  setRefElement,
  selectOption,
  setHighlightedIndex,
  children,
}: {
  globalIndex: number;
  selectedIndex: number | null;
  setRefElement: (el: HTMLElement | null) => void;
  selectOption: () => void;
  setHighlightedIndex: (index: number) => void;
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
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
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
// Block commands render first; the "Skills" section (name + dimmed description +
// monochrome harness badges) renders below when there are matching skills.
export function SlashMenuList({
  commandOptions,
  skillOptions,
  selectedIndex,
  selectOption,
  setHighlightedIndex,
}: {
  commandOptions: SlashMenuOption[];
  skillOptions: SkillMenuOption[];
  selectedIndex: number | null;
  selectOption: (option: SlashOption) => void;
  setHighlightedIndex: (index: number) => void;
}) {
  return (
    <div className="max-h-[min(320px,60vh)] min-w-[220px] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
      {commandOptions.map((option, i) => {
        const Icon = option.spec.icon;
        const active = i === selectedIndex;
        return (
          <SlashMenuRow
            key={option.key}
            globalIndex={i}
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

      {skillOptions.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Skills
          </div>
          {skillOptions.map((option, j) => {
            const globalIndex = commandOptions.length + j;
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
              >
                <span className="truncate">/{name}</span>
                {description ? (
                  <span
                    className={cn(
                      "truncate text-[12px]",
                      active
                        ? "text-accent-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {description}
                  </span>
                ) : null}
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
              </SlashMenuRow>
            );
          })}
        </>
      )}
    </div>
  );
}

export function SlashMenuPlugin({
  skills = EMPTY_SKILLS,
}: {
  // The installed skills to offer below the block commands. Omitted / empty →
  // no Skills section, identical behavior to before this feature.
  skills?: ReadonlyArray<SkillMenuItem>;
}) {
  const [editor] = useLexicalComposerContext();
  // The live query (text after `/`); `null` when the menu is closed.
  const [query, setQuery] = useState<string | null>(null);

  // Trigger on `/` at the start of a block or after whitespace (the regex's
  // `(^|\s|\()` prefix), matching up to 40 query chars. `minLength: 0` so a bare
  // `/` opens the full menu before any filter text is typed.
  const triggerFn = useBasicTypeaheadTriggerMatch("/", {
    minLength: 0,
    maxLength: 40,
  });

  // Two sections, one flat option list for the typeahead. Skills follow the
  // block commands so keyboard nav (↑/↓/Enter, which the plugin drives off this
  // array's order) reads block-commands-then-skills, matching the render order.
  const { commandOptions, skillOptions, options } = useMemo(() => {
    const sections = buildSlashMenuSections(query ?? "", skills);
    return {
      ...sections,
      options: [...sections.commandOptions, ...sections.skillOptions],
    };
  }, [query, skills]);

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
      if (option instanceof SkillMenuOption) {
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

// Stable identity for the default so `SlashMenuPlugin`'s `skills` memo doesn't
// re-run every render when a parent omits the prop.
const EMPTY_SKILLS: ReadonlyArray<SkillMenuItem> = [];
