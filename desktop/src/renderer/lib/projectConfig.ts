import type { Id } from "@convex/_generated/dataModel";

export const PROJECT_CONFIG_PATH = "project.json";

export interface ProjectStatus {
  id: string;
  name: string;
}

export interface ProjectConfig {
  version: 1;
  projectId: Id<"projects">;
  name?: string;
  tasks?: {
    statuses?: ProjectStatus[];
    defaultStatus?: string;
    archiveStatus?: string;
  };
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

  const tasks = isRecord(parsed.tasks) ? parsed.tasks : {};
  const statuses = Array.isArray(tasks.statuses)
    ? tasks.statuses
        .filter(isRecord)
        .map((status) => ({
          id: typeof status.id === "string" ? status.id.trim() : "",
          name: typeof status.name === "string" ? status.name.trim() : "",
        }))
        .filter((status) => status.id && status.name)
    : undefined;

  return {
    version: 1,
    projectId: expectedProjectId,
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    tasks: {
      statuses,
      defaultStatus:
        typeof tasks.defaultStatus === "string" ? tasks.defaultStatus : undefined,
      archiveStatus:
        typeof tasks.archiveStatus === "string" ? tasks.archiveStatus : undefined,
    },
  };
}

