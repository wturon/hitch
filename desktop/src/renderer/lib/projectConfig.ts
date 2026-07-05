import type { Id } from "@convex/_generated/dataModel";

export const PROJECT_CONFIG_PATH = "project.json";

// project.json is a minimal synced descriptor. Todos v1 (slice 6b) dropped the
// board and its `tasks.statuses`/`defaultStatus`/`archiveStatus` config; groups
// are derived client-side from task frontmatter, so nothing per-status is read.
export interface ProjectConfig {
  version: 1;
  projectId: Id<"projects">;
  name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseProjectConfig(
  content: string | undefined,
  expectedProjectId: Id<"projects">,
): ProjectConfig | null {
  if (!content) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.projectId !== expectedProjectId) return null;

  return {
    version: 1,
    projectId: expectedProjectId,
    name: typeof parsed.name === "string" ? parsed.name : undefined,
  };
}
