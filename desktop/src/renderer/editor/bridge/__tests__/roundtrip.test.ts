// Invariant 1 (golden): for every canonical fixture, export(import(md)) is
// byte-for-byte identical to md. This is the whole point of the bridge — a
// load→save of an untouched body must not churn the file.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { roundTrip } from "./harness";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Only the top-level *.md files are canonical golden fixtures. Subdirectories
// (idempotence/, unsupported/) are exercised by their own suites.
const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

describe("golden round-trip: export(import(md)) === md", () => {
  it("has fixtures to test", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("round-trips %s byte-for-byte", (name) => {
    const markdown = readFileSync(join(fixturesDir, name), "utf8");
    expect(roundTrip(markdown)).toBe(markdown);
  });
});
