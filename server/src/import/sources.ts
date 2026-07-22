// THROWAWAY (deleted at M5). The two V1 sources, both reduced to the same
// shape: a list of "source projects" each carrying raw V1 task files.
//
//   --from-dir            a live `.hitch/tasks/` directory (one project's tasks;
//                         V1 encodes the project only by which repo the dir
//                         lives in, so the caller names the target project).
//   --from-convex-export  the banked prod export. Tasks are rows in
//                         files/documents.jsonl (Convex file-sync model):
//                         { _id, projectId, path, content, deleted, hash,
//                           updatedAt, _creationTime }. Tombstones are
//                         deleted:true (content/hash emptied). projects.jsonl
//                         maps projectId → { name, createdBy }; users.jsonl
//                         maps createdBy → email. Filtering to one user =
//                         keeping projects they created — the two users'
//                         projects are disjoint, so this is trivially safe.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { SourceTaskFile } from "./parse.js";

export interface SourceProject {
  name: string;
  createdAtMs: number; // drives project sort order (V1 sidebar ≈ creation order)
  files: SourceTaskFile[];
  tagConfigJson?: string; // raw tasks/config.json, when present
  ignoredNonTaskFiles: number; // notes/, project.json, … — out of D3 scope
}

// --- --from-dir -------------------------------------------------------------

export async function loadFromDir(dir: string, projectName: string): Promise<SourceProject> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SourceTaskFile[] = [];
  let tagConfigJson: string | undefined;
  let ignored = 0;

  for (const entry of entries) {
    if (entry.name === "config.json" && entry.isFile()) {
      tagConfigJson = await readFile(path.join(dir, entry.name), "utf8");
      continue;
    }
    if (!entry.isDirectory()) {
      ignored++;
      continue;
    }
    const taskPath = path.join(dir, entry.name, "task.md");
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(taskPath)).mtimeMs;
    } catch {
      ignored++; // task folder without a canonical task.md — not a card in V1
      continue;
    }
    files.push({
      path: `tasks/${entry.name}/task.md`,
      content: await readFile(taskPath, "utf8"),
      updatedAtMs: mtimeMs,
    });
  }

  return {
    name: projectName,
    createdAtMs: 0,
    files,
    tagConfigJson,
    ignoredNonTaskFiles: ignored,
  };
}

// --- --from-convex-export ---------------------------------------------------

interface ConvexUserRow {
  _id: string;
  email?: string;
}

interface ConvexProjectRow {
  _id: string;
  name: string;
  createdBy: string;
  createdAt?: number;
  _creationTime: number;
}

interface ConvexFileRow {
  projectId: string;
  path: string;
  content: string;
  deleted: boolean;
  updatedAt: number;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

// `root` must be the EXTRACTED export directory (the CLI unzips .zip args
// before calling this).
export async function loadFromConvexExport(
  root: string,
  userEmail: string,
): Promise<SourceProject[]> {
  const users = await readJsonl<ConvexUserRow>(path.join(root, "users", "documents.jsonl"));
  const user = users.find((u) => u.email === userEmail);
  if (!user) {
    const known = users.map((u) => u.email ?? "<no email>").join(", ");
    throw new Error(`no user with email ${userEmail} in export users table (found: ${known})`);
  }

  const projectRows = (
    await readJsonl<ConvexProjectRow>(path.join(root, "projects", "documents.jsonl"))
  ).filter((p) => p.createdBy === user._id);
  const byProjectId = new Map(
    projectRows.map((p) => [
      p._id,
      {
        name: p.name,
        createdAtMs: p.createdAt ?? p._creationTime,
        files: [] as SourceTaskFile[],
        tagConfigJson: undefined as string | undefined,
        ignoredNonTaskFiles: 0,
      },
    ]),
  );

  const fileRows = await readJsonl<ConvexFileRow>(path.join(root, "files", "documents.jsonl"));
  for (const row of fileRows) {
    if (row.deleted) continue; // tombstone — the file no longer exists in V1
    const project = byProjectId.get(row.projectId);
    if (!project) continue; // other user's project
    if (row.path === "tasks/config.json") {
      project.tagConfigJson = row.content;
      continue;
    }
    if (!row.path.startsWith("tasks/") || !row.path.endsWith(".md")) {
      project.ignoredNonTaskFiles++; // notes/, project.json, … — out of D3 scope
      continue;
    }
    project.files.push({
      path: row.path,
      content: row.content,
      updatedAtMs: row.updatedAt,
    });
  }

  // Projects with zero current task files (or none at all for this user) are
  // simply not created — the importer imports tasks, not empty shells.
  return [...byProjectId.values()]
    .filter((p) => p.files.length > 0)
    .map((p) => ({
      name: p.name,
      createdAtMs: p.createdAtMs,
      files: p.files,
      tagConfigJson: p.tagConfigJson,
      ignoredNonTaskFiles: p.ignoredNonTaskFiles,
    }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}
