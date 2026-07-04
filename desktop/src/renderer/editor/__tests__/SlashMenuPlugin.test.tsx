// @vitest-environment jsdom
//
// Tests for the slash-command menu. Three layers, no synthesized keystrokes:
//
//   - `filterSlashCommands` is a pure function (query → visible commands), tested
//     directly for title/keyword matches, case-insensitivity, and zero-match.
//   - Each command's ACTION is run through `applySlashCommand` — the exact path
//     the plugin's `onSelectOption` takes — on a real headless editor, then the
//     resulting document is exported to markdown and asserted (marker present AND
//     the `/query` trigger text gone).
//   - `slashTriggerMatch` (our hand-rolled twin of upstream's
//     `useBasicTypeaheadTriggerMatch`) is also a pure string → match function,
//     tested directly — in particular that it keeps matching through hyphens
//     (kebab-case skill names) while still ending the match at a space.
//
// The rest of the typeahead's trigger/keyboard/anchor plumbing belongs to
// `LexicalTypeaheadMenuPlugin` (upstream, tested there) and depends on real
// selection/DOM-range events that jsdom does not faithfully dispatch — so it is
// covered by the e2e harness run against the real app, not simulated here. See
// the PR notes.
import { createHeadlessEditor } from "@lexical/headless";
import { registerList } from "@lexical/list";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from "lexical";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EDITOR_NODES } from "../config";
import { exportMarkdown } from "../bridge";
import {
  SLASH_COMMANDS,
  SlashMenuList,
  applySkillInsert,
  applySlashCommand,
  buildSlashMenuSections,
  filterSkills,
  filterSlashCommands,
  slashTriggerMatch,
  type SkillMenuItem,
  type SlashCommandSpec,
} from "../SlashMenuPlugin";

// ---------------------------------------------------------------------------
// filterSlashCommands — the pure query filter
// ---------------------------------------------------------------------------
describe("filterSlashCommands", () => {
  const titles = (cmds: SlashCommandSpec[]) => cmds.map((c) => c.title);

  it("returns the full set for an empty or whitespace query", () => {
    expect(filterSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands("   ")).toHaveLength(SLASH_COMMANDS.length);
  });

  it("matches on title substring", () => {
    // "head" hits the three headings' titles.
    expect(titles(filterSlashCommands("head"))).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
    ]);
    expect(titles(filterSlashCommands("divid"))).toEqual(["Divider"]);
  });

  it("matches on keyword when the title does not contain the query", () => {
    // "unordered" is a keyword of Bullet list; its title has neither, and no
    // other keyword contains the full string.
    expect(titles(filterSlashCommands("unordered"))).toEqual(["Bullet list"]);
    // "separator" is a Divider keyword, absent from every title.
    expect(titles(filterSlashCommands("separator"))).toEqual(["Divider"]);
  });

  it("matches purely as a substring (no word boundaries)", () => {
    // "rule" (a Divider keyword) contains "ul", which is also a Bullet list
    // keyword — both surface, proving the match is a raw substring.
    expect(titles(filterSlashCommands("ul"))).toEqual([
      "Bullet list",
      "Divider",
    ]);
  });

  it("is case-insensitive on both title and keyword", () => {
    // Title-side folding.
    expect(titles(filterSlashCommands("HEAD"))).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
    ]);
    // Keyword-side folding: "ol" is a Numbered list keyword only.
    expect(titles(filterSlashCommands("OL"))).toEqual(["Numbered list"]);
  });

  it("returns [] on zero matches", () => {
    expect(filterSlashCommands("zzz")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// slashTriggerMatch — our hand-rolled twin of upstream's
// useBasicTypeaheadTriggerMatch("/", { minLength: 0, maxLength: 40 })
// ---------------------------------------------------------------------------
describe("slashTriggerMatch", () => {
  it("matches a bare trigger (minLength: 0 — the full menu, no filter yet)", () => {
    expect(slashTriggerMatch("/")).toEqual({
      leadOffset: 0,
      matchingString: "",
      replaceableString: "/",
    });
  });

  it("keeps matching through hyphens — the bug: kebab-case skill names", () => {
    // This is the regression: upstream's punctuation set includes `-`, so
    // typing the hyphen in `/be-` used to fail the match and close the menu.
    expect(slashTriggerMatch("/be-")).toEqual({
      leadOffset: 0,
      matchingString: "be-",
      replaceableString: "/be-",
    });
    expect(slashTriggerMatch("/be-concise")).toEqual({
      leadOffset: 0,
      matchingString: "be-concise",
      replaceableString: "/be-concise",
    });
  });

  it("also matches underscores, alongside plain word characters", () => {
    expect(slashTriggerMatch("/foo_bar1")).toEqual({
      leadOffset: 0,
      matchingString: "foo_bar1",
      replaceableString: "/foo_bar1",
    });
  });

  it("still ends the match at a space, closing the menu", () => {
    // A trailing space right after a hyphenated query...
    expect(slashTriggerMatch("/be-concise ")).toBeNull();
    // ...and a space anywhere between the trigger and the caret, even without
    // a hyphen involved.
    expect(slashTriggerMatch("/be con")).toBeNull();
  });

  it("triggers at the start of the text", () => {
    expect(slashTriggerMatch("/h1")).toEqual({
      leadOffset: 0,
      matchingString: "h1",
      replaceableString: "/h1",
    });
  });

  it("triggers after whitespace, with leadOffset at the trigger itself", () => {
    // "hello /wor": the leading space is consumed by the lead group but is not
    // part of leadOffset — leadOffset points at the "/" (index 6).
    expect(slashTriggerMatch("hello /wor")).toEqual({
      leadOffset: 6,
      matchingString: "wor",
      replaceableString: "/wor",
    });
  });

  it("triggers after an opening paren", () => {
    expect(slashTriggerMatch("(/x")).toEqual({
      leadOffset: 1,
      matchingString: "x",
      replaceableString: "/x",
    });
  });

  it("does not trigger when the slash isn't at a valid lead position", () => {
    // "/" preceded by a plain letter — not start-of-text, whitespace, or "(".
    expect(slashTriggerMatch("a/b")).toBeNull();
  });

  it("caps the query at 40 characters, same as upstream's maxLength", () => {
    const forty = "a".repeat(40);
    const fortyOne = "a".repeat(41);
    expect(slashTriggerMatch(`/${forty}`)).toEqual({
      leadOffset: 0,
      matchingString: forty,
      replaceableString: `/${forty}`,
    });
    // One character past the cap: the regex can no longer reach the end of
    // the string within the {0,40} repetition, so the whole match fails
    // (same "too long, menu just closes" behavior as upstream).
    expect(slashTriggerMatch(`/${fortyOne}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command actions — the real onSelectOption path on a headless editor
// ---------------------------------------------------------------------------
function findCommand(key: string): SlashCommandSpec {
  const cmd = SLASH_COMMANDS.find((c) => c.key === key);
  if (!cmd) throw new Error(`no slash command with key "${key}"`);
  return cmd;
}

function newEditor(): LexicalEditor {
  const editor = createHeadlessEditor({
    namespace: "slash-menu-test",
    nodes: [...EDITOR_NODES],
    onError: (error) => {
      throw error;
    },
  });
  // The list commands are wired by ListPlugin in the app; register the same
  // handlers here so the ul/ol actions have something to dispatch to.
  registerList(editor);
  return editor;
}

// Reproduce what the typeahead plugin hands `onSelectOption`: a block whose
// trailing text node holds the `/query` the user typed (optionally preceded by
// other text), with the caret at its end. Run the command through
// `applySlashCommand` (which removes that node, then acts) and return the
// exported markdown.
function runOnBlock(
  key: string,
  { leading, query }: { leading?: string; query: string },
): string {
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      if (leading) paragraph.append($createTextNode(leading));
      const queryNode = $createTextNode(query);
      paragraph.append(queryNode);
      root.append(paragraph);
      // Caret at the end of the query, as it is when the option is chosen.
      queryNode.selectEnd();
      // The exact production cleanup+action, minus the plugin plumbing.
      applySlashCommand(editor, findCommand(key), queryNode);
    },
    { discrete: true },
  );
  return editor.getEditorState().read(() => exportMarkdown());
}

describe("slash command actions (query as the whole block → empty result block)", () => {
  const cases: Array<{ key: string; marker: RegExp; label: string }> = [
    { key: "h1", marker: /^#\s*\n?$/m, label: "H1" },
    { key: "h2", marker: /^##\s*\n?$/m, label: "H2" },
    { key: "h3", marker: /^###\s*\n?$/m, label: "H3" },
    { key: "ul", marker: /^-\s*$/m, label: "bullet" },
    { key: "ol", marker: /^1\.\s*$/m, label: "numbered" },
    { key: "quote", marker: /^>\s*$/m, label: "quote" },
    { key: "hr", marker: /^---$/m, label: "divider" },
  ];

  for (const { key, marker, label } of cases) {
    it(`${label}: produces the marker and drops the /query`, () => {
      const md = runOnBlock(key, { query: "/x" });
      expect(md).toMatch(marker);
      expect(md).not.toContain("/x");
    });
  }
});

describe("slash command actions preserve surviving block text", () => {
  it("heading keeps text typed before the /query", () => {
    // "some text /h1" → the query node is removed, "some text " stays and the
    // paragraph becomes an H1.
    const md = runOnBlock("h1", { leading: "some text ", query: "/head" });
    expect(md).toMatch(/^#\s+some text/);
    expect(md).not.toContain("/head");
  });

  it("quote keeps text typed before the /query", () => {
    const md = runOnBlock("quote", { leading: "wisdom ", query: "/quote" });
    expect(md).toMatch(/^>\s+wisdom/);
    expect(md).not.toContain("/quote");
  });

  it("bullet list keeps text typed before the /query", () => {
    const md = runOnBlock("ul", { leading: "item ", query: "/ul" });
    expect(md).toMatch(/^-\s+item/);
    expect(md).not.toContain("/ul");
  });
});

// ---------------------------------------------------------------------------
// Skills section — filter, section building, insert action, and rendering
// ---------------------------------------------------------------------------
const SKILLS: SkillMenuItem[] = [
  {
    name: "be-concise",
    description: "Trim replies to the essential",
    harnesses: ["claude-code", "codex"],
  },
  { name: "code-review", description: "Review the diff", harnesses: ["claude-code"] },
  { name: "deploy-check", harnesses: ["codex"] },
];

describe("filterSkills", () => {
  const names = (skills: SkillMenuItem[]) => skills.map((s) => s.name);

  it("returns the full set for an empty or whitespace query", () => {
    expect(filterSkills("", SKILLS)).toHaveLength(SKILLS.length);
    expect(filterSkills("   ", SKILLS)).toHaveLength(SKILLS.length);
  });

  it("matches on name substring, case-insensitively", () => {
    expect(names(filterSkills("con", SKILLS))).toEqual(["be-concise"]);
    expect(names(filterSkills("CODE", SKILLS))).toEqual(["code-review"]);
  });

  it("returns [] on zero matches", () => {
    expect(filterSkills("zzz", SKILLS)).toEqual([]);
  });
});

describe("buildSlashMenuSections", () => {
  it("omits the skills section entirely when no skills are supplied", () => {
    const { commandOptions, skillOptions } = buildSlashMenuSections("", []);
    expect(commandOptions).toHaveLength(SLASH_COMMANDS.length);
    expect(skillOptions).toEqual([]);
  });

  it("surfaces matching skills alongside the block commands", () => {
    const { commandOptions, skillOptions } = buildSlashMenuSections("", SKILLS);
    expect(commandOptions).toHaveLength(SLASH_COMMANDS.length);
    expect(skillOptions.map((o) => o.skill.name)).toEqual([
      "be-concise",
      "code-review",
      "deploy-check",
    ]);
  });

  it("filters both sections by the same query", () => {
    // "code" matches the "Code block" command AND the code-review skill.
    const { commandOptions, skillOptions } = buildSlashMenuSections(
      "code",
      SKILLS,
    );
    expect(commandOptions.map((o) => o.spec.title)).toEqual(["Code block"]);
    expect(skillOptions.map((o) => o.skill.name)).toEqual(["code-review"]);
  });
});

// The insert action: unlike a block command, choosing a skill drops PLAIN TEXT
// `/name ` (trailing space) where the `/query` was — no custom node. Mirrors
// runOnBlock but drives `applySkillInsert`, and reads back both the raw text
// content (to prove the trailing space) and the exported markdown.
function insertSkillOnBlock(
  skill: SkillMenuItem,
  { leading, query }: { leading?: string; query: string },
): { text: string; markdown: string } {
  const editor = newEditor();
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      if (leading) paragraph.append($createTextNode(leading));
      const queryNode = $createTextNode(query);
      paragraph.append(queryNode);
      root.append(paragraph);
      queryNode.selectEnd();
      applySkillInsert(editor, skill, queryNode);
    },
    { discrete: true },
  );
  return editor.getEditorState().read(() => ({
    text: $getRoot().getTextContent(),
    markdown: exportMarkdown(),
  }));
}

describe("skill insert action", () => {
  it("replaces the /query with plain text /name and a trailing space", () => {
    const { text, markdown } = insertSkillOnBlock(SKILLS[0], { query: "/be-con" });
    // Exact text, trailing space included — this is the whole feature.
    expect(text).toBe("/be-concise ");
    // Byte-plain markdown: the skill name is just text, and the partial query
    // the user typed is gone.
    expect(markdown).toContain("/be-concise");
    expect(markdown).not.toContain("/be-con\n");
  });

  it("keeps text typed before the /query", () => {
    const { text } = insertSkillOnBlock(SKILLS[1], {
      leading: "run ",
      query: "/code",
    });
    expect(text).toBe("run /code-review ");
  });
});

// The rendered section — one jsdom render asserting the "Skills" header, a row,
// and the monochrome harness badges appear with skill options, and that no header
// shows without them (the compat default). Keyboard/selection itself belongs to
// the typeahead plugin (covered by e2e), so this only checks the paint.
describe("SlashMenuList skills section", () => {
  // Unmount between renders — these tests share a jsdom document.
  afterEach(cleanup);

  function renderList(skills: SkillMenuItem[]) {
    const { commandOptions, skillOptions } = buildSlashMenuSections("", skills);
    render(
      <SlashMenuList
        commandOptions={commandOptions}
        skillOptions={skillOptions}
        selectedIndex={0}
        selectOption={() => {}}
        setHighlightedIndex={() => {}}
      />,
    );
  }

  it("renders the Skills header, rows, and harness badges", () => {
    renderList(SKILLS);
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("/be-concise")).toBeTruthy();
    expect(screen.getByText("Trim replies to the essential")).toBeTruthy();
    // Monochrome harness badges: CC for the two claude-code skills, CX for the
    // two codex ones (be-concise carries both).
    expect(screen.getAllByText("CC")).toHaveLength(2);
    expect(screen.getAllByText("CX")).toHaveLength(2);
  });

  it("shows no Skills section when there are no skills", () => {
    renderList([]);
    expect(screen.queryByText("Skills")).toBeNull();
    // The block commands still render as before.
    expect(screen.getByText("Heading 1")).toBeTruthy();
  });

  // Skills are used more than the block transforms, so they render ABOVE them
  // now (previously below) — assert DOM order directly rather than relying on
  // visual inspection.
  it("renders the Skills section before the block commands", () => {
    renderList(SKILLS);
    const skillsHeader = screen.getByText("Skills");
    const heading1 = screen.getByText("Heading 1");
    // DOCUMENT_POSITION_FOLLOWING on the Heading-1 side means `heading1` comes
    // AFTER `skillsHeader` in the document — i.e. Skills is first.
    expect(
      skillsHeader.compareDocumentPosition(heading1) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // The typeahead drives ↑/↓/Enter off the flat option array's order, which
  // `SlashMenuPlugin` now builds as [...skills, ...commands]; `SlashMenuList`
  // mirrors that in its `globalIndex` math (`skillOptions.length + j` for
  // block commands). These two tests pin that offset from the render side:
  // keyboard/mouse highlight (`aria-selected`) must agree with the new order.
  it("selectedIndex 0 highlights the first SKILL, not the first block command", () => {
    const { commandOptions, skillOptions } = buildSlashMenuSections("", SKILLS);
    render(
      <SlashMenuList
        commandOptions={commandOptions}
        skillOptions={skillOptions}
        selectedIndex={0}
        selectOption={() => {}}
        setHighlightedIndex={() => {}}
      />,
    );
    expect(
      screen
        .getByText("/be-concise")
        .closest('[role="option"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByText("Heading 1")
        .closest('[role="option"]')
        ?.getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("selectedIndex === skillOptions.length highlights the first block command", () => {
    const { commandOptions, skillOptions } = buildSlashMenuSections("", SKILLS);
    render(
      <SlashMenuList
        commandOptions={commandOptions}
        skillOptions={skillOptions}
        selectedIndex={skillOptions.length}
        selectOption={() => {}}
        setHighlightedIndex={() => {}}
      />,
    );
    expect(
      screen
        .getByText("Heading 1")
        .closest('[role="option"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByText("/be-concise")
        .closest('[role="option"]')
        ?.getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("lays out a skill row as two lines: name+badges on line 1, description on line 2", () => {
    renderList(SKILLS);
    const name = screen.getByText("/be-concise");
    const description = screen.getByText("Trim replies to the essential");
    const badge = screen.getAllByText("CC")[0];
    // Name and its badges share the same line-1 container...
    const line1 = name.parentElement;
    expect(line1).toBe(badge.parentElement?.parentElement);
    // ...while the description (line 2) is a direct child of the row, a
    // SIBLING of that line-1 container — one level shallower than the name.
    expect(description.parentElement).toBe(line1?.parentElement);
    expect(description.parentElement).not.toBe(line1);
  });

  it("keeps block-command rows single-line (icon + title, no stacking)", () => {
    renderList(SKILLS);
    const title = screen.getByText("Heading 1");
    // The row <button> itself lays out horizontally (not `flex-col`) for block
    // commands — only the skill rows stack.
    expect(title.closest("button")?.className).not.toContain("flex-col");
  });
});
