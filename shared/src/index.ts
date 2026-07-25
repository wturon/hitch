import { hc } from "hono/client";
import type { ClientRequestOptions } from "hono/client";

import type { AppType } from "@hitch/server";

export const HITCH_API_VERSION = 1;

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
