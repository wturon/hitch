import assert from "node:assert/strict";
import {
  TASK_TITLE_MAX_LENGTH,
  TITLE_PROMPT_MAX_CHARS,
  buildTitlePrompt,
  sanitizeGeneratedTitle,
  titleFromCliResult,
  titleGuardAllows,
} from "../src/taskTitles.js";

// ── sanitizeGeneratedTitle ────────────────────────────────────────────────────
assert.equal(sanitizeGeneratedTitle(undefined), "");
assert.equal(sanitizeGeneratedTitle("   \n  "), "");
assert.equal(
  sanitizeGeneratedTitle("  Fix   the\tlogin  button  "),
  "Fix the login button",
);
// First line only.
assert.equal(
  sanitizeGeneratedTitle("Add dark mode\nand some rambling explanation"),
  "Add dark mode",
);
// Wrapping quotes / backticks are stripped, inner ones kept.
assert.equal(sanitizeGeneratedTitle('"Ship the release"'), "Ship the release");
assert.equal(sanitizeGeneratedTitle("`deploy prod`"), "deploy prod");
assert.equal(sanitizeGeneratedTitle("'it's fine'"), "it's fine");

// Clamp with a trailing "..." at the shared max.
const exact = "x".repeat(TASK_TITLE_MAX_LENGTH);
assert.equal(sanitizeGeneratedTitle(exact), exact);
const long = "word ".repeat(40).trim();
const clamped = sanitizeGeneratedTitle(long);
assert.equal(clamped.length, TASK_TITLE_MAX_LENGTH);
assert.equal(clamped.endsWith("..."), true);

// ── titleFromCliResult ────────────────────────────────────────────────────────
// structured_output wins (present when --json-schema is supplied).
assert.equal(
  titleFromCliResult(
    JSON.stringify({
      result: '{"title":"ignored"}',
      structured_output: { title: "From structured" },
    }),
  ),
  "From structured",
);
// Falls back to parsing the `result` JSON string.
assert.equal(
  titleFromCliResult(JSON.stringify({ result: '{"title":"From result"}' })),
  "From result",
);
// A non-JSON `result` is treated as the raw title.
assert.equal(
  titleFromCliResult(JSON.stringify({ result: "Plain title text" })),
  "Plain title text",
);
// Garbage / missing → "".
assert.equal(titleFromCliResult("not json"), "");
assert.equal(titleFromCliResult(JSON.stringify({ result: 42 })), "");
assert.equal(titleFromCliResult(JSON.stringify({ nothing: true })), "");

// ── buildTitlePrompt ──────────────────────────────────────────────────────────
// The prompt now titles the verbatim body alone (the seed is derived from it, so
// passing it too would only duplicate the body's first words).
const prompt = buildTitlePrompt("Body line one\nBody line two");
assert.equal(prompt.includes("concise task titles"), true);
assert.equal(prompt.includes("Body line one"), true);
assert.equal(prompt.includes("Body line two"), true);
// The body is capped at TITLE_PROMPT_MAX_CHARS, so a huge body is truncated.
const bigBody = "a".repeat(TITLE_PROMPT_MAX_CHARS * 2);
const bigPrompt = buildTitlePrompt(bigBody);
assert.equal(bigPrompt.includes("a".repeat(TITLE_PROMPT_MAX_CHARS)), true);
assert.equal(bigPrompt.includes("a".repeat(TITLE_PROMPT_MAX_CHARS + 1)), false);

// ── titleGuardAllows (the seed guard) ─────────────────────────────────────────
assert.equal(titleGuardAllows("Seed title", "Seed title"), true);
assert.equal(titleGuardAllows("  Seed title  ", "Seed title"), true); // trim-insensitive
assert.equal(titleGuardAllows("", "Seed title"), true); // cleared/missing → allow
assert.equal(titleGuardAllows(undefined, "Seed title"), true);
assert.equal(titleGuardAllows("User renamed it", "Seed title"), false); // human wins

console.log("task title smoke passed");
