// The close path pairs each surface with the workspace that owns it (close-surface
// only resolves a surface UUID within a workspace scope), by walking `cmux tree
// --all --id-format both` output in order. This exercises that pure parse against
// real tree shapes.

import assert from "node:assert/strict";
import { parseSurfacePlacements } from "../src/cmux.js";

// Verbatim shape of `tree --all --id-format both`: windows nest workspaces nest
// panes nest surfaces; annotations ([current], [terminal], tty=…) ride along.
const TREE = `window window:1 14ADF521-07E3-4E83-8CFB-7CE0E61C96E1 [current] ◀ active
├── workspace workspace:1 8A2A61B1-71C1-4954-B0D4-684313CFDE2F "hitch"
│   └── pane pane:1 E8067995-1DEB-4DAC-B9B4-8AFFE5749174 [focused]
│       ├── surface surface:1 B7BCE7AE-5BFA-4E12-B39D-50767145E6CC [terminal] "claude" [selected] tty=ttys019
│       └── surface surface:2 7DF97975-7481-4B9F-8715-6202173DF74D [terminal] "Terminal"
└── workspace workspace:2 11111111-2222-3333-4444-555555555555 "other"
    └── pane pane:2 66666666-7777-8888-9999-000000000000
        └── surface surface:3 AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE [terminal] "sleep 500"
`;

const placements = parseSurfacePlacements(TREE);
assert.deepEqual(placements, [
  {
    surface: "B7BCE7AE-5BFA-4E12-B39D-50767145E6CC",
    workspace: "8A2A61B1-71C1-4954-B0D4-684313CFDE2F",
  },
  {
    surface: "7DF97975-7481-4B9F-8715-6202173DF74D",
    workspace: "8A2A61B1-71C1-4954-B0D4-684313CFDE2F",
  },
  {
    surface: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    workspace: "11111111-2222-3333-4444-555555555555",
  },
]);

// An errored tree reads as empty downstream (cmux.ts tree() catches and returns
// ""), which must parse to zero placements, i.e. "not open anywhere".
assert.deepEqual(parseSurfacePlacements(""), []);

// A surface line with no preceding workspace (shouldn't happen, but the parser
// must not crash or mis-pair) carries a null workspace.
assert.deepEqual(
  parseSurfacePlacements(
    `surface surface:9 AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE [terminal]`,
  ),
  [{ surface: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", workspace: null }],
);

// Lines without UUIDs (default ref-only format) yield nothing rather than junk.
assert.deepEqual(
  parseSurfacePlacements(
    `window window:1 [current]\n└── workspace workspace:1 "hitch"\n    └── surface surface:1 [terminal]`,
  ),
  [],
);

console.log("cmux-close-placements smoke: OK");
