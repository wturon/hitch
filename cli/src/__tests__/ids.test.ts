import { describe, expect, it } from "vitest";

import { resolveByPrefix, shortId } from "../ids.js";

// uuidv7-shaped fixtures: long shared timestamp prefixes are the norm, so
// the helpers must stay correct (and short-ids stay SHORT) under heavy
// prefix overlap — the exact failure mode of ids minted in the same batch.
const A = "0198c2a4-1111-7000-8000-000000000001";
const B = "0198c2a4-2222-7000-8000-000000000002";
const C = "0198c2ff-3333-7000-8000-000000000003";
// Differs from A only in the final character — the worst case.
const NEAR_A = "0198c2a4-1111-7000-8000-000000000009";

describe("shortId", () => {
  it("uses the 8-char minimum when that is already unique", () => {
    expect(shortId(C, [A, B, C])).toBe("0198c2ff");
  });

  it("extends past the minimum until the prefix is unique", () => {
    expect(shortId(A, [A, B, C])).toBe("0198c2a4-1");
  });

  it("falls back to the full id when nothing shorter disambiguates", () => {
    expect(shortId(A, [A, NEAR_A])).toBe(A);
  });

  it("is unaffected by the id's own presence in the set", () => {
    expect(shortId(C, [C])).toBe("0198c2ff");
  });
});

describe("resolveByPrefix", () => {
  const rows = [{ id: A }, { id: B }, { id: C }];

  it("resolves a unique prefix", () => {
    expect(resolveByPrefix(rows, "0198c2ff")).toEqual({ kind: "one", row: { id: C } });
  });

  it("resolves prefixes case-insensitively", () => {
    expect(resolveByPrefix(rows, "0198C2FF")).toEqual({ kind: "one", row: { id: C } });
  });

  it("reports every match when the prefix is ambiguous", () => {
    const match = resolveByPrefix(rows, "0198c2a4");
    expect(match.kind).toBe("many");
    if (match.kind === "many") expect(match.rows.map((r) => r.id)).toEqual([A, B]);
  });

  it("resolves a full id exactly", () => {
    expect(resolveByPrefix([{ id: A }, { id: NEAR_A }], A)).toEqual({ kind: "one", row: { id: A } });
  });

  it("reports no match", () => {
    expect(resolveByPrefix(rows, "ffffffff")).toEqual({ kind: "none" });
  });
});
