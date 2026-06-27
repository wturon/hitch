import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  cwd: "/tmp/my project",
  prompt,
  model: "gpt-5.5",
  effort: "high",
});

// No `env HITCH_* …` prefix anymore: the command is plain Codex. The cmux
// environment is inferred from CMUX_SURFACE_ID and the launch is correlated via
// the surface-keyed claim, not env vars on the command.
assert.doesNotMatch(start, /^env\s/);
assert.doesNotMatch(start, /HITCH_LAUNCH_ID/);
assert.doesNotMatch(start, /HITCH_CHAT_ENVIRONMENT/);
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
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const claims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].launchId, "launch-1");
  assert.equal(claims[0].environment, "cmux");
  assert.equal(typeof claims[0].createdAt, "number");
  assert.equal(claims[0].surfaceId, undefined);

  // onPlaced stamps the surface id — the join key the hook matches CMUX_SURFACE_ID against.
  updateCodexCmuxLaunchClaim({
    launchId: "launch-1",
    surfaceId: "surface-1",
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const updatedClaims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  );
  assert.equal(updatedClaims[0].surfaceId, "surface-1");

  // Two launches in the same repo with the same prompt no longer collide: each
  // gets its own claim keyed by its own (later-stamped) surface id.
  recordCodexCmuxLaunchClaim({
    launchId: "launch-2",
    env: { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv,
  });
  const twoClaims = JSON.parse(
    readFileSync(join(tempDir, "codex-cmux-launch-claims.json"), "utf8"),
  );
  assert.equal(twoClaims.length, 2);
  assert.deepEqual(
    twoClaims.map((claim: { launchId: string }) => claim.launchId).sort(),
    ["launch-1", "launch-2"],
  );
  for (const claim of twoClaims) {
    assert.equal(claim.ambiguousAt, undefined);
    assert.equal(claim.promptHash, undefined);
    assert.equal(claim.cwd, undefined);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("codex cmux command smoke passed");
