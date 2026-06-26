import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  recordCodexCmuxLaunchClaim,
  updateCodexCmuxLaunchClaim,
} from "../src/codexCmuxLaunchClaims.js";
import {
  codexResumeCommand,
  codexStartCommand,
} from "../src/launchers/cmuxCodex.js";

const prompt = "don't lose\nthis prompt";
const start = codexStartCommand({
  launchId: "launch-1",
  cwd: "/tmp/my project",
  prompt,
  model: "gpt-5.5",
  effort: "high",
});

assert.match(start, /^env\s/);
assert.match(start, /\s'?HITCH_LAUNCH_ID=launch-1'?\s/);
assert.match(start, /\s'?HITCH_CHAT_ENVIRONMENT=cmux'?\s/);
assert.match(start, /\s-C\s'\/tmp\/my project'/);
assert.match(start, /\s--model\sgpt-5\.5/);
assert.match(start, /-c\s'model_reasoning_effort="high"'/);
assert.match(start, /'don'\\''t lose\nthis prompt'$/);

const resume = codexResumeCommand({
  threadId: "thread-1",
  cwd: "/tmp/my project",
});

assert.match(resume, /\sresume\s/);
assert.match(resume, /\sthread-1$/);
assert.doesNotMatch(resume, /don't lose/);

const tempDir = mkdtempSync(join(tmpdir(), "hitch-codex-cmux-claim-"));
try {
  recordCodexCmuxLaunchClaim({
    launchId: "launch-1",
    cwd: "/tmp/my project",
    prompt,
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const claims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].launchId, "launch-1");
  assert.equal(claims[0].cwd, resolve("/tmp/my project"));
  assert.equal(claims[0].environment, "cmux");
  assert.equal(
    claims[0].promptHash,
    createHash("sha256").update(prompt).digest("hex"),
  );
  assert.equal(typeof claims[0].createdAt, "number");

  updateCodexCmuxLaunchClaim({
    launchId: "launch-1",
    workspaceId: "workspace-1",
    surfaceId: "surface-1",
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const updatedClaims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  );
  assert.equal(updatedClaims[0].workspaceId, "workspace-1");
  assert.equal(updatedClaims[0].surfaceId, "surface-1");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("codex cmux command smoke passed");
