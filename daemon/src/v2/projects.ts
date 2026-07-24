// Projects provider (daemon side).
//
// The chat-state observer maps a chat's cwd → a project via a list of
// {projectId, localPath}. That list comes from the server's `projects` rows that
// carry a `repo_path` (the machine-local checkout): we fetch GET /projects, keep
// the subset with a repo_path, and refresh whenever the server broadcasts a
// `projects` invalidation over the WS.
//
// The observer holds `this.projects` by reference and re-reads it every
// reconcile (projectForCwd iterates it), so we hand it a SINGLE array and
// refresh it IN PLACE (splice) — never reassign — so a refresh is visible to
// the already-constructed observer.

import type { ObserverProject } from "../observer/projects.js";
import type { HitchClient } from "./serverClient.js";

export interface ProjectsProviderLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface ProjectsProviderOptions {
  client: HitchClient;
  logger: ProjectsProviderLogger;
}

// Minimal shape we read off a server project row. The wire row has more fields;
// we only need id + repoPath here.
interface ServerProjectRow {
  id: string;
  repoPath: string | null;
}

export class ProjectsProvider {
  // The live array handed to the observer. Mutated in place by refresh().
  readonly list: ObserverProject[] = [];
  private readonly client: HitchClient;
  private readonly logger: ProjectsProviderLogger;

  constructor(options: ProjectsProviderOptions) {
    this.client = options.client;
    this.logger = options.logger;
  }

  // Fetch GET /projects and replace `list`'s contents with the repo_path-bearing
  // projects. Failures are logged and leave the previous list intact — a
  // transient server blip must not blank the observer's project map (which would
  // make every live chat "unknown project").
  async refresh(): Promise<void> {
    let rows: ServerProjectRow[];
    try {
      const res = await this.client.projects.$get();
      if (!res.ok) {
        this.logger.error?.(`[hitch] projects refresh failed (${res.status})`);
        return;
      }
      rows = (await res.json()) as ServerProjectRow[];
    } catch (error) {
      this.logger.error?.(`[hitch] projects refresh error: ${String(error)}`);
      return;
    }

    const next: ObserverProject[] = [];
    for (const row of rows) {
      const localPath = typeof row.repoPath === "string" ? row.repoPath.trim() : "";
      if (!localPath) continue;
      next.push({ projectId: row.id, localPath });
    }
    // Replace in place so the observer's held reference sees the update.
    this.list.splice(0, this.list.length, ...next);
    this.logger.info(
      `[hitch] projects refreshed: ${next.length} with a repo path (of ${rows.length})`,
    );
  }
}
