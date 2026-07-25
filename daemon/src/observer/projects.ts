import { relative, resolve, sep } from "node:path";

// The subset of a project the observer needs to associate a chat (by its cwd)
// with a project. Populated from the server's projects (see v2/projects.ts),
// kept as a minimal shape so the observer doesn't reach into the provider.
export interface ObserverProject {
  projectId: string;
  localPath: string;
}

function isInside(root: string, cwd: string): boolean {
  const rel = relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

// Resolve a chat's cwd to the hitch project that contains it. When folders
// nest, the deepest (longest localPath) match wins so a chat in a sub-project
// binds to the sub-project, not its parent. Returns null for a cwd outside
// every hitched folder — the caller surfaces those as "unknown project".
export function projectForCwd(
  projects: ObserverProject[],
  cwd: string,
): ObserverProject | null {
  const resolved = resolve(cwd || ".");
  let best: ObserverProject | null = null;
  for (const project of projects) {
    const root = resolve(project.localPath);
    if (!isInside(root, resolved)) continue;
    if (!best || root.length > resolve(best.localPath).length) best = project;
  }
  return best;
}
