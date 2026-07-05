// The pure chat model: how a task's `chat-*` frontmatter is parsed into a chat
// reference, live status, and delegation-request state. Split out of ./chat so
// the Todos derivation (./todos) has a fully pure import chain that BOTH worlds
// consume — the renderer, and the Convex sidebar-badge query
// (convex/files.ts), which imports the derivation core directly so there is no
// hand-maintained twin of the harness list / status aliases / request rules /
// compat shim on the server.
//
// PURITY CONTRACT: no React, no DOM (`window`), no Convex imports, no
// import.meta. This file is typechecked under BOTH tsconfigs (renderer, which
// has DOM libs, and convex, which doesn't) and bundled by both Vite and
// Convex's esbuild. ./chat re-exports everything here, so UI code keeps
// importing from "@/lib/chat" unchanged; presentation-flavored helpers
// (harnessLabel, model/effort catalogs, localStorage persistence) stay in
// ./chat.

import type { Frontmatter } from "./frontmatter";
import { setFrontmatterKeys } from "./frontmatter";

export type Harness = "claude-code" | "codex";

export interface ChatRef {
  harness: Harness;
  id: string;
  cwd?: string; // claude-code only: where to resume the session
}

export const HARNESSES: Harness[] = ["claude-code", "codex"];

// Live runtime state of the chat driving a task, written into frontmatter as
// `chat-status` by the harness's lifecycle hooks (see .claude/hooks/chat-status.mjs):
//   working — mid-turn, actively processing (no human action needed)
//   needs-input — mid-turn but blocked on the human (e.g. a tool-permission
//     prompt); the agent can't proceed until you respond
//   waiting — finished a turn, your turn to act
// Absent means we have no live signal (chat closed, never linked, or pre-hooks).
export type ChatStatus = "working" | "needs-input" | "waiting";

const CHAT_STATUSES = new Set<string>(["working", "needs-input", "waiting"]);

const CHAT_STATUS_ALIASES: Record<string, ChatStatus> = {
  active: "working",
  busy: "working",
  running: "working",
  ready: "waiting",
  idle: "waiting",
  needs_input: "needs-input",
  "needs-help": "needs-input",
};

function normalizeStatusValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function normalizeChatStatus(value: string): ChatStatus | null {
  const normalized = normalizeStatusValue(value);
  if (CHAT_STATUSES.has(normalized)) return normalized as ChatStatus;
  return CHAT_STATUS_ALIASES[normalized] ?? null;
}

export function parseChatStatus(fm: Frontmatter): ChatStatus | null {
  return normalizeChatStatus(fm["chat-status"] ?? "");
}

// Codex threads launched by Hitch's daemon briefly exist only inside the
// daemon-managed app-server. During that handoff window, opening the normal
// `codex://threads/<id>` deep link can strand the user on a loading screen.
export type ChatOpenState = "pending";

export function parseChatOpenState(fm: Frontmatter): ChatOpenState | null {
  return normalizeStatusValue(fm["chat-open-state"] ?? "") === "pending"
    ? "pending"
    : null;
}

// A fire-and-forget delegation request planted on the task before any agent
// exists. It is the durable "summoning" flag: the user hits ⌘↩, the server
// stamps the doc + enqueues a launch command, and the card reflects it
// immediately via the files subscription — no open dialog required. The daemon
// clears it on bind (the real chat-* fields take over) or flips it to `failed`
// if the launch can't be provisioned (cmux gone, harness misconfigured).
//
//   chat-request: requested        (or `failed`)
//   chat-request-harness: codex    (which agent — drives the chip icon)
//   chat-request-error: <reason>   (failed only; short, for the tooltip)
export const CHAT_REQUEST_KEY = "chat-request";
export const CHAT_REQUEST_HARNESS_KEY = "chat-request-harness";
export const CHAT_REQUEST_ERROR_KEY = "chat-request-error";
// The launch this flag belongs to. The daemon correlates a command's failure to
// the doc's *current* request via this id, so a stale command's late failure
// can't clobber a newer request the user has since re-fired (see the daemon's
// markDelegationFailed). Cleared alongside the rest on bind / clear.
export const CHAT_REQUEST_ID_KEY = "chat-request-id";

export type DelegationRequestState = "requested" | "failed";

export interface DelegationRequest {
  state: DelegationRequestState;
  harness: Harness;
  error?: string;
}

export function parseDelegationRequest(fm: Frontmatter): DelegationRequest | null {
  const raw = normalizeStatusValue(fm[CHAT_REQUEST_KEY] ?? "");
  if (raw !== "requested" && raw !== "failed") return null;
  const rawHarness = (fm[CHAT_REQUEST_HARNESS_KEY] ?? "").trim();
  // A launch genuinely in flight must never be hidden just because the harness
  // key is missing/unknown (a hand-edit or a cross-version harness rename) —
  // hiding it silently drops the band back to compose and re-arms Send. Show the
  // state with a best-effort harness for the icon instead.
  const harness = isHarness(rawHarness) ? rawHarness : "claude-code";
  const error = (fm[CHAT_REQUEST_ERROR_KEY] ?? "").trim();
  return { state: raw, harness, error: error || undefined };
}

// Stamp a fresh "requested" flag onto raw file content, tagged with the launch
// id so a later failure can be matched back to this exact request. Any stale
// error is cleared so a retry after a failure reads clean.
export function stampDelegationRequest(
  content: string,
  harness: Harness,
  launchId: string,
): string {
  return setFrontmatterKeys(content, {
    [CHAT_REQUEST_KEY]: "requested",
    [CHAT_REQUEST_HARNESS_KEY]: harness,
    [CHAT_REQUEST_ID_KEY]: launchId,
    [CHAT_REQUEST_ERROR_KEY]: undefined,
  });
}

// Remove every delegation-request key. Used when a real chat binds (handoff to
// chat-*) and when the user clears a failed request.
export function clearDelegationRequest(content: string): string {
  return setFrontmatterKeys(content, {
    [CHAT_REQUEST_KEY]: undefined,
    [CHAT_REQUEST_HARNESS_KEY]: undefined,
    [CHAT_REQUEST_ID_KEY]: undefined,
    [CHAT_REQUEST_ERROR_KEY]: undefined,
  });
}

// The states the delegation UI distinguishes: the agent is mid-turn
// ("working"), mid-turn but blocked on the human ("needs-input"), it has a live
// signal but isn't mid-turn ("not-working"), or we have no live signal at all
// ("none" — closed, never linked, or a harness like Codex with no status
// hooks). "waiting" collapses into "not-working".
export type ChatActivity = "working" | "needs-input" | "not-working" | "none";

export function chatActivity(status: ChatStatus | null): ChatActivity {
  if (status === "working") return "working";
  if (status === "needs-input") return "needs-input";
  return status ? "not-working" : "none";
}

export function isHarness(value: string): value is Harness {
  return (HARNESSES as string[]).includes(value);
}

// Read a chat reference from parsed frontmatter. Returns null unless both a
// known harness and a non-empty id are present, so callers can treat null as
// "no usable link yet".
export function parseChatRef(fm: Frontmatter): ChatRef | null {
  const harness = (fm["chat-harness"] ?? "").trim();
  const id = (fm["chat-id"] ?? "").trim();
  const cwd = (fm["chat-cwd"] ?? "").trim();
  if (!isHarness(harness) || !id) return null;
  return cwd ? { harness, id, cwd } : { harness, id };
}
