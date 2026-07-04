// @vitest-environment jsdom
//
// Tests for the slash-command menu. Two layers, no synthesized keystrokes:
//
//   - `filterSlashCommands` is a pure function (query → visible commands), tested
//     directly for title/keyword matches, case-insensitivity, and zero-match.
//   - Each command's ACTION is run through `applySlashCommand` — the exact path
//     the plugin's `onSelectOption` takes — on a real headless editor, then the
//     resulting document is exported to markdown and asserted (marker present AND
//     the `/query` trigger text gone).
//
// The typeahead trigger/keyboard/anchor behavior itself belongs to
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
