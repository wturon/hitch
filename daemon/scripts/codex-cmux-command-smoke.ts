import assert from "node:assert/strict";
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

console.log("codex cmux command smoke passed");
