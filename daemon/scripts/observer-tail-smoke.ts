import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLatestTail, tailFile } from "../src/observer/tail.js";

const dir = mkdtempSync(join(tmpdir(), "hitch-observer-tail-"));
const path = join(dir, "rollout.jsonl");

try {
  // Cold start on an empty/absent file.
  assert.equal(tailFile(join(dir, "missing.jsonl"), null), null);

  writeFileSync(path, 'line-1\nline-2\n', "utf8");
  const first = tailFile(path, null);
  assert.ok(first);
  assert.deepEqual(first.lines, ["line-1", "line-2"]);
  assert.equal(first.changed, true);

  // No change since the last cursor → no new lines.
  const noop = tailFile(path, first.cursor);
  assert.ok(noop);
  assert.deepEqual(noop.lines, []);
  assert.equal(noop.changed, false, "unchanged file = changed:false");

  // Append a complete line plus a partial trailing line. Only the complete line
  // is yielded; the partial is held for next time (offset stays before it).
  appendFileSync(path, 'line-3\n{"partial":', "utf8");
  const second = tailFile(path, noop.cursor);
  assert.ok(second);
  assert.deepEqual(second.lines, ["line-3"]);
  assert.equal(second.changed, true);

  // Complete the partial line; now it's yielded exactly once (never twice, never
  // half-parsed).
  appendFileSync(path, 'true}\n', "utf8");
  const third = tailFile(path, second.cursor);
  assert.ok(third);
  assert.deepEqual(third.lines, ['{"partial":true}']);

  // Truncation (size shrank below the offset) → reset, re-read from the window.
  writeFileSync(path, 'fresh-1\n', "utf8");
  const afterTruncate = tailFile(path, third.cursor);
  assert.ok(afterTruncate);
  assert.equal(afterTruncate.reset, true, "truncation triggers a reset");
  assert.deepEqual(afterTruncate.lines, ["fresh-1"]);

  // Cold read with a tiny window begins mid-line; the leading partial is dropped.
  writeFileSync(path, "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n", "utf8");
  const windowed = tailFile(path, null, { initialWindowBytes: 15 });
  assert.ok(windowed);
  assert.equal(
    windowed.lines.includes("cccccccccc"),
    true,
    "the last full line is always present in the window",
  );
  assert.equal(
    windowed.lines.includes("aaaaaaaaaa"),
    false,
    "a line outside the window is not read",
  );

  // --- readLatestTail: level-triggered (the open-tool-stays-working case) ----
  const lt = join(dir, "transcript.jsonl");
  writeFileSync(
    lt,
    '{"type":"assistant","message":{"stop_reason":"tool_use"}}\n',
    "utf8",
  );
  const t1 = readLatestTail(lt, null);
  assert.ok(t1);
  assert.equal(t1.changed, true);
  assert.deepEqual(t1.lines, [
    '{"type":"assistant","message":{"stop_reason":"tool_use"}}',
  ]);

  // Quiet tick — no new bytes — but the current tail STILL carries the open
  // tool_use line. This is the fix: derivation sees "working" across silent
  // ticks instead of going blank on the delta.
  const t2 = readLatestTail(lt, t1.cursor);
  assert.ok(t2);
  assert.equal(t2.changed, false, "unchanged file = changed:false");
  assert.deepEqual(
    t2.lines,
    ['{"type":"assistant","message":{"stop_reason":"tool_use"}}'],
    "the current latest-turn line is re-read every tick, not just the delta",
  );

  // Turn closes — the terminal marker now appears in the current tail.
  appendFileSync(
    lt,
    '{"type":"assistant","message":{"stop_reason":"end_turn"}}\n',
    "utf8",
  );
  const t3 = readLatestTail(lt, t2.cursor);
  assert.ok(t3);
  assert.equal(t3.changed, true);
  assert.equal(
    t3.lines.at(-1),
    '{"type":"assistant","message":{"stop_reason":"end_turn"}}',
  );

  console.log("observer-tail-smoke: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
