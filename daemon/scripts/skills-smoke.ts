import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanSkills,
  skillRootsForProject,
  type SkillScanRoot,
} from "../src/skills";

// Invent a skill on disk: a `<root>/<name>/SKILL.md` with the given (optional)
// frontmatter body. Fixture content is fabricated — never copied from a real
// ~/.claude skill.
function writeSkill(
  root: string,
  name: string,
  frontmatter?: { name?: string; description?: string },
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  if (frontmatter) {
    lines.push("---");
    if (frontmatter.name !== undefined) lines.push(`name: ${frontmatter.name}`);
    if (frontmatter.description !== undefined) {
      lines.push(`description: ${frontmatter.description}`);
    }
    lines.push("---");
    lines.push("");
  }
  lines.push(`# ${name}`, "", "Fixture skill body — not a real skill.", "");
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf8");
}

const tmp = mkdtempSync(join(tmpdir(), "hitch-skills-"));

try {
  const home = join(tmp, "home");
  const proj = join(tmp, "proj");
  const claudeGlobal = join(home, ".claude", "skills");
  const codexGlobal = join(home, ".codex", "skills");
  const claudeProject = join(proj, ".claude", "skills");

  // Same name in both global roots → ONE row, two installs.
  writeSkill(claudeGlobal, "be-concise", {
    name: "be-concise",
    description: "Trim replies to the essential",
  });
  writeSkill(codexGlobal, "be-concise", { name: "be-concise" });
  // A codex-only global skill.
  writeSkill(codexGlobal, "codex-only", {
    name: "codex-only",
    description: "Only installed for codex",
  });
  // A project-scoped skill, plus one with no frontmatter (name falls back to the
  // directory) and a directory that is NOT a skill (no SKILL.md → ignored).
  writeSkill(claudeProject, "deploy", {
    name: "deploy",
    description: "Ship it",
  });
  writeSkill(claudeProject, "no-frontmatter");
  mkdirSync(join(claudeProject, "not-a-skill"), { recursive: true });
  // A stray file (not a directory) sitting in a root — must be skipped, not read.
  writeFileSync(join(claudeProject, "README.md"), "not a skill", "utf8");

  const roots: SkillScanRoot[] = [
    { dir: claudeGlobal, harness: "claude-code", scope: "global" },
    { dir: codexGlobal, harness: "codex", scope: "global" },
    { dir: claudeProject, harness: "claude-code", scope: "project" },
    // Deliberately missing — this project has no ~/.codex-equivalent project dir.
    { dir: join(proj, ".codex", "skills"), harness: "codex", scope: "project" },
  ];

  const skills = scanSkills(roots);

  // Sorted by name; only real skills (not the bare directory / stray file).
  assert.deepEqual(
    skills.map((s) => s.name),
    ["be-concise", "codex-only", "deploy", "no-frontmatter"],
  );

  // be-concise merged across both global roots into one row with two installs;
  // the description comes from the first root that supplied one.
  const beConcise = skills.find((s) => s.name === "be-concise");
  assert.ok(beConcise);
  assert.equal(beConcise.description, "Trim replies to the essential");
  assert.equal(beConcise.installs.length, 2);
  assert.deepEqual(
    beConcise.installs.map((i) => `${i.harness}:${i.scope}`).sort(),
    ["claude-code:global", "codex:global"],
  );
  assert.ok(
    beConcise.installs.every((i) => i.path.endsWith("/SKILL.md")),
    "install path points at the SKILL.md file",
  );

  // codex-only: single install, correct harness + scope.
  const codexOnly = skills.find((s) => s.name === "codex-only");
  assert.ok(codexOnly);
  assert.equal(codexOnly.installs.length, 1);
  assert.equal(codexOnly.installs[0]?.harness, "codex");
  assert.equal(codexOnly.installs[0]?.scope, "global");

  // deploy: project-scoped.
  const deploy = skills.find((s) => s.name === "deploy");
  assert.ok(deploy);
  assert.equal(deploy.installs[0]?.scope, "project");
  assert.equal(deploy.installs[0]?.harness, "claude-code");

  // no-frontmatter: name falls back to the directory, description absent.
  const fallback = skills.find((s) => s.name === "no-frontmatter");
  assert.ok(fallback);
  assert.equal(fallback.description, undefined);

  // A completely empty root set is fine and yields nothing.
  assert.deepEqual(scanSkills([]), []);

  // Missing roots don't throw — a machine with no skills at all scans clean.
  assert.deepEqual(
    scanSkills([
      { dir: join(tmp, "does", "not", "exist"), harness: "codex", scope: "global" },
    ]),
    [],
  );

  // skillRootsForProject wires the four expected (harness, scope) roots.
  const projectRoots = skillRootsForProject(proj);
  assert.deepEqual(
    projectRoots.map((r) => `${r.harness}:${r.scope}`),
    [
      "claude-code:global",
      "codex:global",
      "claude-code:project",
      "codex:project",
    ],
  );
  assert.ok(
    projectRoots
      .filter((r) => r.scope === "project")
      .every((r) => r.dir.startsWith(proj)),
    "project-scoped roots live under the project's localPath",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("skills scan smoke passed");
