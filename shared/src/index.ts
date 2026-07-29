import { hc } from "hono/client";
import type { ClientRequestOptions } from "hono/client";

import type { AppType } from "@hitch/server";

export const HITCH_API_VERSION = 1;

export {
  DEFAULT_TEXT_GENERATION_MODEL,
  deriveTitleFromBody,
  isTextGenerationModel,
  taskTitleSeed,
  TEXT_GENERATION_MODELS,
} from "./taskTitles.js";
export type { TextGenerationModel } from "./taskTitles.js";

// The full route tree type — hc<AppType> gives end-to-end typed requests.
export type { AppType } from "@hitch/server";

// Row types (drizzle $inferSelect, re-exported through @hitch/server).
// Note: over the wire, Date fields arrive as ISO strings (JSON).
export type {
  Assignment,
  Attachment,
  Chat,
  ChatEvent,
  Comment,
  Machine,
  Project,
  Section,
  Tag,
  Task,
  TaskTag,
} from "@hitch/server";

// Chat observation axes + the status function (docs/chat-tracking-redesign.md
// §3). `deriveChatStatus` is exported so consumers can *explain* a status, not
// so they can compute one — the server is the only writer of chats.status.
export { deriveChatStatus } from "@hitch/server";
export type {
  ChatActivity,
  ChatAxes,
  ChatBlock,
  ChatExistence,
  ChatStatus,
} from "@hitch/server";

// Prompt templates (server/src/prompt.ts). A delegation prompt is a template
// whose $TASK_TITLE / $TASK_BODY / $TASK_ID are substituted by the SERVER when
// the assignment is created — POST /assignments is the only resolution point.
// These are exported so clients can compose and display templates against the
// same framing text, never so they can resolve one themselves.
export {
  DEFAULT_PROMPT_TEMPLATE,
  EMPTY_BODY_PLACEHOLDER,
  PROMPT_TEMPLATE_FRAMING,
  PROMPT_VARIABLES,
  resolvePromptTemplate,
} from "@hitch/server";
export type { PromptTask } from "@hitch/server";

// WS wire protocol for the /ws endpoint (invalidation broadcast + ephemeral
// event relay). Connect with `new WebSocket(baseUrl.replace(/^http/, "ws") +
// "/ws")`, authed by the same cookie / x-api-key headers as HTTP.
export type {
  WsClientEventMessage,
  WsClientMessage,
  WsEventMessage,
  WsHelloMessage,
  WsInvalidateMessage,
  WsServerMessage,
} from "@hitch/server";

// Explicit alias so the declaration emit doesn't have to name hono internals.
export type HitchClient = ReturnType<typeof hc<AppType>>;

// Auth (better-auth on the server): pass a session cookie via
// `opts.headers.cookie` (desktop) or an API key via
// `opts.headers["x-api-key"]` (CLI + daemon). Both come from the server's
// /api/auth/* endpoints — sign-in sets the cookie; a signed-in session
// creates keys at /api/auth/api-key/create.
export function createHitchClient(baseUrl: string, opts?: ClientRequestOptions): HitchClient {
  return hc<AppType>(baseUrl, opts);
}
