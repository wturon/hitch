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

  recordCodexCmuxLaunchClaim({
    launchId: "duplicate-1",
    cwd: "/tmp/my project",
    prompt: "same prompt",
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  recordCodexCmuxLaunchClaim({
    launchId: "duplicate-2",
    cwd: "/tmp/my project",
    prompt: "same prompt",
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const duplicateClaims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  ).filter((claim: { launchId?: string }) =>
    claim.launchId?.startsWith("duplicate-"),
  );
  assert.equal(duplicateClaims.length, 2);
  assert.deepEqual(
    duplicateClaims.map((claim: { launchId: string }) => claim.launchId).sort(),
    ["duplicate-1", "duplicate-2"],
  );
  assert.equal(typeof duplicateClaims[0].ambiguousAt, "number");
  assert.equal(duplicateClaims[0].ambiguousAt, duplicateClaims[1].ambiguousAt);
  assert.equal(duplicateClaims[0].ambiguousMatchCount, 2);
  assert.equal(duplicateClaims[1].ambiguousMatchCount, 2);
  assert.equal(duplicateClaims[0].claimedAt, undefined);
  assert.equal(duplicateClaims[1].claimedAt, undefined);

  recordCodexCmuxLaunchClaim({
    launchId: "duplicate-3",
    cwd: "/tmp/my project",
    prompt: "same prompt",
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const thirdDuplicateClaims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  ).filter((claim: { launchId?: string }) =>
    claim.launchId?.startsWith("duplicate-"),
  );
  assert.equal(thirdDuplicateClaims.length, 3);
  assert.deepEqual(
    thirdDuplicateClaims
      .map((claim: { launchId: string }) => claim.launchId)
      .sort(),
    ["duplicate-1", "duplicate-2", "duplicate-3"],
  );
  for (const claim of thirdDuplicateClaims) {
    assert.equal(typeof claim.ambiguousAt, "number");
    assert.equal(claim.ambiguousMatchCount, 3);
    assert.equal(claim.claimedAt, undefined);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("codex cmux command smoke passed");
