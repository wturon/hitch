// Compile-time-only test: verifies the typed client resolves the server's
// route tree end-to-end. Never executed (excluded from the build; only the
// `typecheck` script sees it) — every assignment below is a type assertion.

import { createHitchClient } from "../index.js";
import type { Assignment, Attachment, Comment, Machine, Project, Task } from "../index.js";

// JSON serialization turns Date fields into ISO strings; everything else
// crosses the wire unchanged.
type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

const client = createHitchClient("http://127.0.0.1:3010", {
  headers: { "x-api-key": "compile-time-only" },
});

export async function typechecks(): Promise<void> {
  // List with typed filters.
  const listRes = await client.tasks.$get({
    query: { project_id: "id", status: "open", tag_id: "id" },
  });
  if (listRes.status === 200) {
    const rows = await listRes.json();
    const task: Serialized<Task> = rows[0];
    const id: Task["id"] = task.id;
    const status: Task["status"] = task.status;
    const body: Task["body"] = task.body;
    const completedAt: string | null = task.completedAt;
    void [id, status, body, completedAt];
  }

  // Create with typed body.
  const createRes = await client.tasks.$post({
    json: { projectId: "id", title: "t", body: "verbatim", sortOrder: "a0" },
  });
  if (createRes.status === 201) {
    const created: Serialized<Task> = await createRes.json();
    void created;
  }

  // Get-one narrows 200 vs 404.
  const getRes = await client.projects[":id"].$get({ param: { id: "id" } });
  if (getRes.status === 200) {
    const project: Serialized<Project> = await getRes.json();
    void project;
  } else if (getRes.status === 404) {
    // (=== 404 can't exclude the success member — its status type is the
    // broad ContentfulStatusCode — so no strict annotation here.)
    const err = await getRes.json();
    void err;
  }

  // Client assignment PATCH only accepts client-writable fields.
  const patchRes = await client.assignments[":id"].$patch({
    param: { id: "id" },
    json: { desiredState: "stopped", reviewedAt: new Date().toISOString() },
  });
  if (patchRes.status === 200) {
    const assignment: Serialized<Assignment> = await patchRes.json();
    void assignment;
  }

  // Daemon observation PATCH is the mirror image.
  const daemonPatch = await client.daemon.assignments[":id"].$patch({
    param: { id: "id" },
    json: { observedState: "waiting_input", chatId: "id", worktree: "/tmp/wt" },
  });
  if (daemonPatch.status === 200) {
    const assignment: Serialized<Assignment> = await daemonPatch.json();
    void assignment;
  }

  // Attachments: create returns the row + a presigned PUT url; download
  // returns a JSON {url} (presigned GET), not a redirect.
  const attachmentRes = await client.attachments.$post({
    json: {
      taskId: "id",
      filename: "diagram.png",
      mime: "image/png",
      size: 1234,
      sha256: "0".repeat(64),
    },
  });
  if (attachmentRes.status === 201) {
    const { attachment, uploadUrl } = await attachmentRes.json();
    const created: Serialized<Attachment> = attachment;
    const url: string = uploadUrl;
    void [created, url];
  }
  const downloadRes = await client.attachments[":id"].download.$get({ param: { id: "id" } });
  if (downloadRes.status === 200) {
    const { url } = await downloadRes.json();
    const download: string = url;
    void download;
  }

  // Machines + comments round out the tree.
  const machinesRes = await client.machines.$get();
  if (machinesRes.status === 200) {
    const machines: Serialized<Machine>[] = await machinesRes.json();
    void machines;
  }
  const commentsRes = await client.comments.$get({ query: { task_id: "id" } });
  if (commentsRes.status === 200) {
    const comments: Serialized<Comment>[] = await commentsRes.json();
    void comments;
  }
}
