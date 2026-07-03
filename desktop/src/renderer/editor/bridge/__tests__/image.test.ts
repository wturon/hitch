// The supported/unsupported image boundary. A regular `![alt](url)` is modelled
// as an inline ImageNode; an `imageReference` (`![alt][id]` + a separate
// `definition`) has no visitor and must stay unsupported — falling its whole
// enclosing block to a byte-preserving UnknownBlockNode, never a lossy image.
import { describe, expect, it } from "vitest";

import { importedNodeTypes, roundTrip } from "./harness";

describe("image bridge boundary", () => {
  it("imports a regular image as an inline image node", () => {
    const types = importedNodeTypes("![alt](x.png)\n");
    expect(types).toContain("image");
    expect(types).not.toContain("unknown-block");
  });

  it("keeps a mid-sentence image inline inside its paragraph", () => {
    const types = importedNodeTypes("before ![a](x.png) after\n");
    // paragraph → [text, image, text] — the image sits between text runs.
    expect(types).toEqual(["paragraph", "text", "image", "text"]);
  });

  it("keeps an image REFERENCE unsupported (unknown block, not an image)", () => {
    const md = "![alt][ref]\n\n[ref]: https://example.com/img.png\n";
    const types = importedNodeTypes(md);
    expect(types).toContain("unknown-block");
    expect(types).not.toContain("image");
    // …and the whole thing still round-trips byte-for-byte.
    expect(roundTrip(md)).toBe(md);
  });
});
