import type { ProjectStatus } from "@/lib/projectConfig";

export const DEFAULT_STATUSES = [
  { id: "todo", name: "To Do" },
  { id: "in-progress", name: "In Progress" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
] as const satisfies ProjectStatus[];

export function statusesForProject(
  statuses: ProjectStatus[] | undefined,
): ProjectStatus[] {
  return statuses?.length ? statuses : [...DEFAULT_STATUSES];
}

export function statusIdFromName(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function uniqueStatusId(name: string, existing: ProjectStatus[]) {
  const root = statusIdFromName(name) || "status";
  const taken = new Set(existing.map((status) => status.id));
  let id = root === "archived" ? "status" : root;
  let suffix = 2;
  while (taken.has(id) || id === "archived") {
    id = `${root}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function statusCardCountLabel(count: number | null) {
  if (count === null) return "Loading";
  return `${count} card${count === 1 ? "" : "s"}`;
}

export function statusFrontmatterLine(id: string) {
  return `status: ${id}`;
}
