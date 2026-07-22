import { createNodeWebSocket } from "@hono/node-ws";
import type { NodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import type { WSContext } from "hono/ws";
import pg from "pg";
import type { WebSocket } from "ws";
import { z } from "zod";

import { requireAuth } from "./auth.js";
import type { AppEnv, Db } from "./context.js";
import { ownedMachine } from "./routes/helpers.js";

// The realtime layer (see docs/v2-prd.md "Realtime"): everything flows through
// the server, in exactly two forms — never a stored command queue.
// - INVALIDATIONS: pg LISTEN on `hitch_changes` (the migration-0001 NOTIFY
//   triggers) → broadcast {type:"invalidate", ...} → clients refetch.
// - EVENTS (focus; later pings): ephemeral relay. No table, no retry, no ack;
//   nobody listening → the event evaporates.

// ---------------------------------------------------------------------------
// Wire protocol (shared/ re-exports these types for the M2 client + daemon)
// ---------------------------------------------------------------------------

/**
 * Server → client: a row changed — refetch anything derived from `table`.
 * Regular tables carry `id`; task_tags has a composite PK and carries
 * `task_id` + `tag_id` instead (payload shapes come from migration 0001).
 */
export type WsInvalidateMessage = {
  type: "invalidate";
  table: string;
  id?: string;
  task_id?: string;
  tag_id?: string;
};

/** Server → client: an ephemeral event relayed from another connection. */
export type WsEventMessage = { type: "event"; event: string; payload?: unknown };

export type WsServerMessage = WsInvalidateMessage | WsEventMessage;

/**
 * Client → server: register this connection as the daemon for a machine
 * (must belong to the connection's user; invalid hellos are ignored).
 */
export type WsHelloMessage = { type: "hello"; machineId: string };

/**
 * Client → server: relay an ephemeral event ("focus" today, pings later) to
 * the connections hello'd for `machineId` (must belong to the sender's user).
 */
export type WsClientEventMessage = {
  type: "event";
  event: string;
  machineId: string;
  payload?: unknown;
};

export type WsClientMessage = WsHelloMessage | WsClientEventMessage;

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), machineId: z.uuid() }),
  z.object({
    type: z.literal("event"),
    event: z.string().min(1),
    machineId: z.uuid(),
    payload: z.json().optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Connection registry + /ws endpoint
// ---------------------------------------------------------------------------

// Per-socket record. In-memory only, cleaned up on close — this is the
// ephemeral layer, nothing here is ever persisted.
type Connection = {
  userId: string;
  /** Set by a valid hello — marks this connection as the daemon for a machine. */
  machineId?: string;
  /** Set in onOpen; every registry member has one. */
  ctx?: WSContext<WebSocket>;
};

const OPEN = 1; // WebSocket.OPEN

/**
 * Mounts the /ws endpoint on the app and returns the invalidation broadcaster.
 *
 * createNodeWebSocket needs the live app instance (its upgrade handler
 * re-dispatches the HTTP upgrade request through app.request), so this runs
 * after createApp instead of inside it — createApp stays a pure factory, and
 * the /ws route is deliberately NOT part of AppType: hc<AppType> is for HTTP
 * routes, and WS clients connect with plain `new WebSocket(...)`.
 *
 * Upgrade auth is the same single path as every HTTP route: requireAuth runs
 * on the upgrade request (better-auth getSession over its headers), covering
 * the desktop session cookie and the daemon/CLI x-api-key header alike — node
 * WS clients can set arbitrary headers. An unauthenticated upgrade gets the
 * 401 written to the socket and the connection is never established.
 */
export function attachWebSocket(app: Hono<AppEnv>): {
  injectWebSocket: NodeWebSocket["injectWebSocket"];
  broadcastInvalidate: (change: Record<string, unknown>) => void;
} {
  const connections = new Set<Connection>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Invalidations go to ALL authenticated connections, not per-user — a
  // DELIBERATE v1 simplification. The payload is just a table name + uuid;
  // the actual data refetch is auth-scoped HTTP, so nothing meaningful leaks.
  // Per-user routing would require resolving each row to its owner, which
  // breaks on DELETEs (the row is already gone when the NOTIFY arrives).
  const broadcastInvalidate = (change: Record<string, unknown>) => {
    const message = JSON.stringify({ type: "invalidate", ...change });
    for (const conn of connections) {
      if (conn.ctx?.readyState === OPEN) conn.ctx.send(message);
    }
  };

  app.get(
    "/ws",
    requireAuth,
    upgradeWebSocket((c) => {
      // upgradeWebSocket's context is untyped; both vars were set upstream
      // (db in createApp's injector, userId by requireAuth just now).
      const db = c.get("db") as Db;
      const userId = c.get("userId") as string;
      const conn: Connection = { userId };

      return {
        onOpen(_evt, ws) {
          conn.ctx = ws;
          connections.add(conn);
        },
        async onMessage(evt) {
          // Malformed frames are dropped silently — the socket stays up.
          let raw: unknown;
          try {
            raw = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          const parsed = clientMessage.safeParse(raw);
          if (!parsed.success) return;
          const msg = parsed.data;

          // Both message kinds name a machine that must belong to the
          // sender's user; anything else is ignored (indistinguishable from
          // "no such machine", matching the HTTP 404-on-not-yours rule).
          // node-ws doesn't await async handlers, so a db failure here must
          // not escape as an unhandled rejection — drop the message instead.
          let machine;
          try {
            machine = await ownedMachine(db, userId, msg.machineId);
          } catch (error) {
            console.error("[ws] machine ownership lookup failed:", error);
            return;
          }
          if (!machine) return;

          if (msg.type === "hello") {
            conn.machineId = msg.machineId;
            return;
          }

          // Ephemeral relay: forward to the connections hello'd for the
          // machine. No ack, no retry — nobody listening means it evaporates.
          const out = JSON.stringify({
            type: "event",
            event: msg.event,
            payload: msg.payload,
          });
          for (const target of connections) {
            if (target.machineId === msg.machineId && target.ctx?.readyState === OPEN) {
              target.ctx.send(out);
            }
          }
        },
        onClose() {
          connections.delete(conn);
        },
      };
    }),
  );

  return { injectWebSocket, broadcastInvalidate };
}

// ---------------------------------------------------------------------------
// pg LISTEN client
// ---------------------------------------------------------------------------

/**
 * Subscribes a dedicated pg Client (NOT the pool — LISTEN binds to a single
 * session) to `hitch_changes` and feeds every parsed payload to `onChange`.
 * Reconnects with capped exponential backoff if the connection drops; a
 * missed window is harmless because clients refetch on their own reconnect.
 *
 * `ready` resolves after the first successful LISTEN (boot logging + tests).
 */
export function startChangeListener(options: {
  connectionString: string;
  onChange: (change: Record<string, unknown>) => void;
}): { ready: Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  let client: pg.Client | undefined;
  let attempt = 0;
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    attempt += 1;
    console.error(`[ws] hitch_changes listener reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  };

  const connect = async () => {
    if (stopped) return;
    const next = new pg.Client({ connectionString: options.connectionString });
    client = next;
    // 'error' and 'end' can both fire on a dropped connection — reconnect once.
    let failed = false;
    const fail = (error: unknown) => {
      if (failed || stopped) return;
      failed = true;
      console.error("[ws] hitch_changes listener lost:", error);
      void next.end().catch(() => {});
      scheduleReconnect();
    };
    next.on("error", fail);
    next.on("end", () => fail(new Error("connection ended")));
    try {
      await next.connect();
      await next.query("LISTEN hitch_changes");
    } catch (error) {
      fail(error);
      return;
    }
    attempt = 0;
    next.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        options.onChange(JSON.parse(msg.payload) as Record<string, unknown>);
      } catch {
        console.error(`[ws] unparseable hitch_changes payload: ${msg.payload}`);
      }
    });
    console.log("[ws] listening for hitch_changes");
    resolveReady();
  };

  void connect();

  return {
    ready,
    async stop() {
      stopped = true;
      await client?.end().catch(() => {});
    },
  };
}
