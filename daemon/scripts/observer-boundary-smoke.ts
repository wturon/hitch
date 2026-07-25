// THE OBSERVATION-LAYER BOUNDARY (docs/chat-tracking-redesign.md §4).
//
//   "the observation layer must compile and pass its tests with ZERO imports
//    from `daemon/src/launchers/` or anything cmux. Make it a lint rule."
//
// This repo has no eslint (no config, no dependency, no lint script in any
// workspace), so the idiomatic mechanism HERE is the same one every other
// invariant uses: a `smoke:*` script. It is also strictly stronger than
// `no-restricted-imports`, which only sees DIRECT imports: this walks the
// module graph, so `observer/x.ts → v2/y.ts → cmux.ts` fails too.
//
// Why the rule exists: observation must be environment-blind. Chats are found
// on a machine, not in a terminal — the moment sensing can reach a launcher,
// "is this chat alive" starts depending on how it was started, and a chat in a
// bare terminal stops being representable. The attachment layer
// (daemon/src/attachment/) is the only thing allowed to know about launches,
// and the observer reaches it through a plain data interface it declares
// itself (observer/types.ts: AttachmentSource).
//
// To see it fail: add `import { openChat } from "../cmux.js";` to any file in
// daemon/src/observer/ and run this.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(fileURLToPath(new URL("../src", import.meta.url)));
const OBSERVER = join(SRC, "observer");

/** What observation may never reach, directly or transitively. */
const FORBIDDEN: Array<{ label: string; matches: (path: string) => boolean }> = [
  {
    label: "daemon/src/launchers/",
    matches: (path) => path.startsWith(join(SRC, "launchers") + "/"),
  },
  { label: "daemon/src/cmux.ts", matches: (path) => path === join(SRC, "cmux.ts") },
  {
    label: "daemon/src/attachment/",
    matches: (path) => path.startsWith(join(SRC, "attachment") + "/"),
  },
];

// Every `from "…"` / `import "…"` / `import("…")` specifier in a file.
function importsOf(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

// NodeNext specifiers are written with a .js extension; resolve back to source.
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // a package — can't be our own src
  const raw = resolve(dirname(fromFile), specifier);
  const candidates = [raw.replace(/\.js$/, ".ts"), `${raw}.ts`, join(raw, "index.ts"), raw];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesIn(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

const roots = tsFilesIn(OBSERVER);
assert.ok(roots.length > 0, "found no observer sources — did the layer move?");

// Breadth-first over the module graph, remembering how we got somewhere so a
// transitive violation names its whole chain.
const seen = new Set<string>(roots);
const queue: Array<{ file: string; chain: string[] }> = roots.map((file) => ({
  file,
  chain: [relative(SRC, file)],
}));
const violations: string[] = [];

while (queue.length > 0) {
  const { file, chain } = queue.shift()!;
  for (const specifier of importsOf(readFileSync(file, "utf8"))) {
    // A non-relative specifier can still name the forbidden zones (a path
    // alias, a self-referential package import) — reject it on sight.
    if (!specifier.startsWith(".")) {
      if (/(^|\/)launchers(\/|$)|cmux/i.test(specifier)) {
        violations.push(`${chain.join(" → ")} → ${specifier}`);
      }
      continue;
    }
    const target = resolveSpecifier(file, specifier);
    if (!target) continue;
    const forbidden = FORBIDDEN.find((zone) => zone.matches(target));
    if (forbidden) {
      violations.push(`${chain.join(" → ")} → ${relative(SRC, target)} (${forbidden.label})`);
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    queue.push({ file: target, chain: [...chain, relative(SRC, target)] });
  }
}

assert.deepEqual(
  violations,
  [],
  "daemon/src/observer/ must not reach launchers/cmux/attachment:\n  " + violations.join("\n  "),
);

// A guard on the guard: the walk has to actually be walking. If the module
// graph ever collapses to "just the observer's own files", the check above
// would pass vacuously for the wrong reason.
// STRICTLY greater: `seen` is SEEDED with the roots, so `>=` would hold even if
// the walk resolved nothing at all.
assert.ok(
  seen.size > roots.length,
  `the walk resolved no imports beyond the observer's own ${roots.length} files — ` +
    `resolveSpecifier is probably broken, and this check is passing vacuously`,
);

console.log(
  `observer-boundary smoke: OK (${roots.length} observer file(s), ${seen.size} module(s) reachable, 0 violations)`,
);
