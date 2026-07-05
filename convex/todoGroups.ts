// Server-side twin of the todos-v1 group predicate (desktop lib/todos.ts
// `groupOf`), projected down to the two attention buckets the sidebar badges
// need: WORKING and NEEDS YOU. Pure string logic — no Convex, no renderer
// imports — so `convex/files.ts` can count without shipping task contents to the
// client, and so this stays unit-testable in isolation. The group vocabulary
// (predicate order, chat-status/request aliases, compat shim) is kept in lockstep
// with lib/todos.ts + lib/chat.ts so the badges match the list exactly.
//
// COMPAT SHIM (delete in slice 6): a legacy `status: done`/`status: archived`
// file still counts as done/archived (never toward a badge); every other legacy
// `status:` value is ignored (the task falls through to backlog → uncounted).

// Leading YAML frontmatter block. Mirrors lib/frontmatter.ts FRONTMATTER_RE.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

const KNOWN_HARNESSES = new Set(["claude-code", "codex"]);

// The two buckets the sidebar tallies. `null` = not counted (done, archived,
// backlog, or not a bound/requested task).
export type CountedGroup = "working" | "needs-you";

// Parse the frontmatter block into a flat key→value map, stripping surrounding
// quotes. Server-side twin of lib/frontmatter.ts parseFrontmatter (block only).
export function readFrontmatter(content: string): Record<string, string> {
  const match = content.match(FRONTMATTER_RE);
  const fm: Record<string, string> = {};
  if (!match) return fm;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    fm[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return fm;
}

function normalizeStatusValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function present(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

// `chat-id` resolves to a bound chat only when a known harness AND a non-empty
// id are both present — matches lib/chat.ts parseChatRef.
function chatPresent(fm: Record<string, string>): boolean {
  return KNOWN_HARNESSES.has((fm["chat-harness"] ?? "").trim()) &&
    present(fm["chat-id"]);
}

// chat-status === working, honoring the working aliases in lib/chat.ts.
function chatWorking(fm: Record<string, string>): boolean {
  const v = normalizeStatusValue(fm["chat-status"] ?? "");
  return v === "working" || v === "active" || v === "busy" || v === "running";
}

// The durable pre-bind summon flag (requested|failed) — lib/chat.ts
// parseDelegationRequest. Both states fold into WORKING.
function requestPresent(fm: Record<string, string>): boolean {
  const v = normalizeStatusValue(fm["chat-request"] ?? "");
  return v === "requested" || v === "failed";
}

function legacyStatus(fm: Record<string, string>): string {
  return (fm["status"] ?? "").trim().toLowerCase();
}

function isDone(fm: Record<string, string>): boolean {
  return present(fm["completed-at"]) || legacyStatus(fm) === "done";
}

function isArchived(fm: Record<string, string>): boolean {
  return present(fm["archived-at"]) || legacyStatus(fm) === "archived";
}

// The counted group for one task body, evaluated top-down (first match wins) —
// exactly lib/todos.ts groupOf, collapsed so done/archived/backlog all read as
// `null` (uncounted). Returns "working" or "needs-you" only.
export function taskCountedGroup(content: string): CountedGroup | null {
  const fm = readFrontmatter(content);
  if (isArchived(fm)) return null; // 1. archived
  if (isDone(fm)) return null; // 2. done
  if (requestPresent(fm)) return "working"; // 3. requested/failed summon flag
  if (chatPresent(fm) && chatWorking(fm)) return "working"; // 4. bound + working
  if (chatPresent(fm)) return "needs-you"; // 5. bound + not working
  return null; // 6. backlog
}
