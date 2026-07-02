// Invariant 2 (idempotence): non-canonical inputs (star/plus bullets, setext
// headings, underscore emphasis) normalize on the FIRST pass, and a SECOND pass
// is byte-stable. This guarantees the editor converges — once a body has been
// saved through the bridge, re-saving it never churns again.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { roundTrip } from "./harness";

const idempotenceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "idempotence",
);

const inputs = readdirSync(idempotenceDir)
  .filter((name) => name.endsWith(".in.md"))
  .sort();

describe("idempotence: normalize once, then byte-stable", () => {
  it("has fixtures to test", () => {
    expect(inputs.length).toBeGreaterThan(0);
  });

  it.each(inputs)("%s normalizes then stabilizes", (name) => {
    const input = readFileSync(join(idempotenceDir, name), "utf8");
    const firstPass = roundTrip(input);
    const secondPass = roundTrip(firstPass);
    // The second pass must be byte-identical to the first.
    expect(secondPass).toBe(firstPass);
    // These inputs are deliberately non-canonical, so the first pass must have
    // actually changed something — otherwise the fixture proves nothing.
    expect(firstPass).not.toBe(input);
  });
});
