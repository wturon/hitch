// Agent-skill scanner. Skills are directories holding a `SKILL.md` under a
// harness's skills root (e.g. ~/.claude/skills/<name>/SKILL.md). The filesystem
// is the source of truth; this module scans those roots and mirrors what it finds
// into Convex's `skills` table (a derived index the editor's `/` menu reads).
//
// There is NO file watcher here on purpose: the daemon has a history of fd
// exhaustion from per-file watches, so the lifecycle re-scans on an interval
// instead (see startSkillSync + its wiring in daemon.ts).
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

export type SkillHarness = "claude-code" | "codex";
export type SkillScope = "global" | "project";

// One skills directory to scan, tagged with how its contents should be recorded.
export interface SkillScanRoot {
  dir: string; // absolute path to a `.../skills` directory
  harness: SkillHarness;
  scope: SkillScope;
}

// Where a single skill lives on disk. One skill name can have several installs
// (e.g. the same skill available to both claude-code and codex).
export interface SkillInstall {
  harness: SkillHarness;
  scope: SkillScope;
  path: string; // absolute path to the skill's SKILL.md
}

// One skill, merged across every root it was found in. Shape matches the
// `skills.replace` mutation's per-skill arg.
export interface SkillRow {
  name: string;
  description?: string;
  installs: SkillInstall[];
}

// Leading YAML frontmatter block. Mirrors FRONTMATTER_RE in daemon.ts.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Read a single flat key from a SKILL.md's frontmatter. Mirrors frontmatterValue
// in daemon.ts — deliberately flat (no nested YAML / lists), which keeps the
// daemon free of a YAML dependency. Only `name` and `description` are consulted.
function frontmatterValue(content: string, key: string): string | undefined {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    return value || undefined;
  }
  return undefined;
}

// Scan a set of roots one level deep and merge the results by skill name. Pure
// and Convex-free so it's unit-testable against fixture directories. Missing
// roots are normal (a machine may not use every harness) and are silently
// skipped; a subdirectory without a SKILL.md isn't a skill and is skipped too.
export function scanSkills(roots: ReadonlyArray<SkillScanRoot>): SkillRow[] {
  const byName = new Map<string, SkillRow>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      // Missing (or unreadable) root — not an error, just nothing to scan.
      continue;
    }
    for (const entry of [...entries].sort()) {
      const skillMd = join(root.dir, entry, "SKILL.md");
      let content: string;
      try {
        content = readFileSync(skillMd, "utf8");
      } catch {
        // No SKILL.md (or `entry` isn't a directory) → not a skill.
        continue;
      }
      const name = frontmatterValue(content, "name") ?? entry;
      const description = frontmatterValue(content, "description");
      const install: SkillInstall = {
        harness: root.harness,
        scope: root.scope,
        path: skillMd,
      };
      const existing = byName.get(name);
      if (existing) {
        existing.installs.push(install);
        // First root to describe the skill wins; later ones only fill a gap.
        if (existing.description === undefined && description !== undefined) {
          existing.description = description;
        }
      } else {
        byName.set(name, { name, description, installs: [install] });
      }
    }
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// The four roots to scan for one project: the two global harness roots under the
// home directory (shared by every hitched project on this machine) plus the
// project's own `.claude`/`.codex` skill dirs.
export function skillRootsForProject(localPath: string): SkillScanRoot[] {
  const home = homedir();
  return [
    { dir: join(home, ".claude", "skills"), harness: "claude-code", scope: "global" },
    { dir: join(home, ".codex", "skills"), harness: "codex", scope: "global" },
    { dir: join(localPath, ".claude", "skills"), harness: "claude-code", scope: "project" },
    { dir: join(localPath, ".codex", "skills"), harness: "codex", scope: "project" },
  ];
}

// A hitched project the daemon knows about, projected down to what the skill sync
// needs (mirrors the observer's ObserverProject shape).
export interface SkillSyncProject {
  projectId: string;
  localPath: string;
}

export interface SkillSyncDeps {
  client: ConvexClient;
  deviceToken: string | undefined;
  host: string;
  projects: ReadonlyArray<SkillSyncProject>;
  logger: { info: (message: string) => void; error?: (message: string) => void };
}

// Scan every hitched project's skill roots and replace its rows in Convex. The
// filesystem is truth, so `skills.replace` hard-deletes rows this scan no longer
// sees. Non-fatal: a failure for one project is logged and the rest proceed (the
// next interval tick retries).
export async function syncSkills(deps: SkillSyncDeps): Promise<void> {
  for (const project of deps.projects) {
    try {
      const skills = scanSkills(skillRootsForProject(project.localPath));
      await deps.client.mutation(anyApi.skills.replace, {
        projectId: project.projectId,
        host: deps.host,
        skills,
        deviceToken: deps.deviceToken,
      });
    } catch (err) {
      (deps.logger.error ?? deps.logger.info)(
        `[skills] sync failed for ${project.localPath}: ${String(err)}`,
      );
    }
  }
}

// Re-scan on an interval — the same cadence the spec calls for, matching the
// house style for periodic daemon work (fire once now, then setInterval).
export const SKILL_SCAN_INTERVAL_MS = 5 * 60_000;

// Kick a scan immediately and every 5 minutes thereafter. Returns a handle whose
// stop() clears the timer (called from the daemon's stop()).
export function startSkillSync(deps: SkillSyncDeps): { stop: () => void } {
  void syncSkills(deps);
  const timer = setInterval(
    () => void syncSkills(deps),
    SKILL_SCAN_INTERVAL_MS,
  );
  return {
    stop: () => clearInterval(timer),
  };
}
