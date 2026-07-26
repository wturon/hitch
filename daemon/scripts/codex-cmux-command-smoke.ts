import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCmuxLaunch } from "../src/attachment/launches.js";
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
  launchId: "launch-1",
});

// THE JOIN KEY, on the command itself. Codex has no `--session-id`, so this
// nonce is the only thing that can pair a chat with the launch that started it:
// Codex exports its environment to every hook process, so the hook reports this
// value next to Codex's own session id. A shell assignment prefix (not `env `)
// because cmux types this line into a pane as literal shell text.
assert.match(start, /^HITCH_LAUNCH_ID=launch-1\s/);
// The environment does NOT travel on the command — it belongs to the launch
// record the daemon already holds. A chat's identity must not depend on which
// terminal it happens to be running in.
assert.doesNotMatch(start, /HITCH_CHAT_ENVIRONMENT/);
assert.match(start, /\s-C\s'\/tmp\/my project'/);
assert.match(start, /\s--model\sgpt-5\.5/);
assert.match(start, /-c\s'model_reasoning_effort="high"'/);
assert.match(start, /'don'\\''t lose\nthis prompt'$/);

// A launch with no id is still a valid command — it just can't be attached.
const anonymous = codexStartCommand({ cwd: "/tmp/x", prompt: "hi" });
assert.doesNotMatch(anonymous, /HITCH_LAUNCH_ID/);

// Nonces are shell-quoted like everything else: a hostile value can't break out
// of the assignment and append a command.
const quoted = codexStartCommand({ prompt: "hi", launchId: "a b; rm -rf /" });
assert.match(quoted, /^HITCH_LAUNCH_ID='a b; rm -rf \/'\s/);

// An EMPTY prompt still has to reach codex as an argument. The bare-word fast
// path in shellQuote has no character to object to in "", so an unguarded
// version returns it unquoted and the prompt vanishes from the command line
// entirely — codex would open an interactive session instead of a seeded one,
// and nothing downstream would report why.
const empty = codexStartCommand({ cwd: "/tmp/x", prompt: "" });
assert.match(empty, /\s''$/, "an empty prompt is quoted, not dropped");

const resume = codexResumeCommand({
  threadId: "thread-1",
  cwd: "/tmp/my project",
});

assert.match(resume, /\sresume\s/);
assert.match(resume, /\sthread-1$/);
assert.doesNotMatch(resume, /don't lose/);

// The launcher's half of the attachment layer: record the launch so the daemon
// can resolve the nonce when the hook hands it back. (The MATCH happens in the
// daemon — see scripts/attachment-smoke.ts — but the record must be on disk
// before Codex can fire a hook.)
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
  // No surface id is written any more — nothing about the pane is part of a
  // launch record now.
  assert.equal(claims[0].surfaceId, undefined);

  // Recording the same launch twice MERGES: the reconciler registers the
  // attachment (assignment/cwd/title) and the launcher then records the same
  // launch as a cmux launch — neither may clobber the other, and there must
  // never be two records for one launchId (the nonce is a primary key).
  recordCmuxLaunch({ launchId: "launch-1", harness: "codex", env });
  const merged = readLaunches();
  assert.equal(merged.length, 1, "a second record for the same launch merges");
  assert.equal(merged[0].harness, "codex", "and keeps what was already there");

  // Two launches in the same repo with the same prompt cannot collide: each
  // carries its own nonce.
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
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("codex cmux command smoke passed");
