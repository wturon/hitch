"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import type { SkillMenuItem } from "@/editor";

// Collapse the per-(host) skill rows into the flat, editor-shaped list the `/`
// menu wants: one entry per skill name, with the union of harnesses across every
// host that reported it. The Convex table already stores one row per
// (project, host, name), so there's no scope filtering to do here — the daemon
// only ever writes rows for the project it scanned.
function mergeSkills(rows: ReadonlyArray<Doc<"skills">>): SkillMenuItem[] {
  const byName = new Map<
    string,
    { name: string; description?: string; harnesses: Set<string> }
  >();
  for (const row of rows) {
    let entry = byName.get(row.name);
    if (!entry) {
      entry = { name: row.name, description: row.description, harnesses: new Set() };
      byName.set(row.name, entry);
    } else if (entry.description === undefined && row.description !== undefined) {
      // First host to describe the skill wins; later hosts only fill a gap.
      entry.description = row.description;
    }
    for (const install of row.installs) entry.harnesses.add(install.harness);
  }
  return Array.from(byName.values())
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      harnesses: Array.from(entry.harnesses).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The installed skills for a project, ready to hand to `MarkdownEditor`'s
// `skills` prop. Returns `[]` while loading or when there are none, so the editor
// just shows no Skills section (its compat default).
export function useSkills(
  projectId: Id<"projects"> | null | undefined,
): ReadonlyArray<SkillMenuItem> {
  const rows = useQuery(
    api.skills.list,
    projectId ? { projectId } : "skip",
  );

  return useMemo(() => mergeSkills(rows ?? []), [rows]);
}
