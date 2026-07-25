import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCmuxLaunch, stampCmuxSurface } from "../src/attachment/launches.js";
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

// The launcher's half of the attachment layer: record the launch, then stamp
// the cmux surface onto it before the command runs. (The MATCH now happens in
// the daemon — see scripts/attachment-smoke.ts — but this is still where the
// join key is written, and it must be on disk before Codex can fire a hook.)
const tempDir = mkdtempSync(join(tmpdir(), "hitch-codex-cmux-claim-"));
const env = { HITCH_APP_SUPPORT_DIR: tempDir } as NodeJS.ProcessEnv;
const readLaunches = () =>
  JSON.parse(readFileSync(join(tempDir, "launches.json"), "utf8")) as Array<
    Record<string, unknown>
  >;
try {
  recordCmuxLaunch({ launchId: "launch-1", harness: "codex", env });
  const claims = readLaunches();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].launchId, "launch-1");
  assert.equal(claims[0].environment, "cmux");
  assert.equal(typeof claims[0].createdAt, "number");
  assert.equal(claims[0].surfaceId, undefined);

  // beforeCommand stamps the surface id — the join key CMUX_SURFACE_ID is
  // matched against when the hook reports it.
  stampCmuxSurface({ launchId: "launch-1", surfaceId: "surface-1", env });
  assert.equal(readLaunches()[0].surfaceId, "surface-1");

  // Recording the same launch twice MERGES: the reconciler registers the
  // attachment (assignment/cwd/title) and the launcher then records the same
  // launch as a cmux launch — neither may clobber the other, and there must
  // never be two records for one launchId (that would make the surface match
  // ambiguous and it would refuse to bind).
  recordCmuxLaunch({ launchId: "launch-1", harness: "codex", env });
  const merged = readLaunches();
  assert.equal(merged.length, 1, "a second record for the same launch merges");
  assert.equal(merged[0].surfaceId, "surface-1", "and keeps the stamped surface");

  // Two launches in the same repo with the same prompt no longer collide: each
  // gets its own record keyed by its own (later-stamped) surface id.
  recordCmuxLaunch({ launchId: "launch-2", harness: "codex", env });
  const twoClaims = readLaunches();
  assert.equal(twoClaims.length, 2);
  assert.deepEqual(
    twoClaims.map((claim) => claim.launchId).sort(),
    ["launch-1", "launch-2"],
  );
  for (const claim of twoClaims) {
    assert.equal(claim.ambiguousAt, undefined);
    assert.equal(claim.promptHash, undefined);
    assert.equal(claim.cwd, undefined);
  }

  // Stamping a launch we never recorded is a no-op, not an invention: a claim
  // with no launch behind it could only ever bind a thread to nothing.
  stampCmuxSurface({ launchId: "launch-unknown", surfaceId: "surface-9", env });
  assert.equal(readLaunches().length, 2);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("codex cmux command smoke passed");
