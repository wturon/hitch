// V2 server WebSocket client (daemon side).
//
// Runtime choice — the `ws` npm package, NOT the native/undici global:
//   - `ws` is already a daemon dependency and already imported in daemon.ts;
//     the packaged runner bundles it, so nothing new ships.
//   - `ws`'s constructor takes a first-class `{ headers }` bag, so the
//     x-api-key auth header works with zero DOM-typing casts (the desktop main
//     had to cast the native global — see hitchServer.ts NodeWebSocketCtor).
//   - It behaves identically whether the daemon runs under system Node via tsx
//     (dev) or Electron's embedded Node via ELECTRON_RUN_AS_NODE (prod), so we
//     don't depend on a given Node build shipping header support on the global.
//
// Contract (server/src/ws.ts): connect to <serverUrl>/ws with x-api-key, send
// {type:"hello", machineId} to register as this machine's daemon, then receive
// {type:"invalidate",...} and {type:"event",...}. Reconnect re-hellos every
// time (server registry is per-socket, dropped on close).

import WebSocket from "ws";

import type { WsEventMessage, WsInvalidateMessage, WsServerMessage } from "@hitch/shared";

export interface ServerWsLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface ServerWsClientOptions {
  serverUrl: string;
  apiKey: string;
  machineId: string;
  logger: ServerWsLogger;
  /** Backoff ceiling; overridable so tests don't wait 30s. Default 30_000. */
  maxBackoffMs?: number;
}

type InvalidateHandler = (message: WsInvalidateMessage) => void;
type EventHandler = (message: WsEventMessage) => void;

export interface ServerWsClient {
  /** Register a handler for invalidations of `table`. Returns an unsubscribe. */
  onInvalidate(table: string, handler: InvalidateHandler): () => void;
  /** Register a handler for the named ephemeral event. Returns an unsubscribe. */
  onEvent(event: string, handler: EventHandler): () => void;
  /**
   * Register a handler fired on every RE-connect (not the initial connect) —
   * the reconnect trigger for the reconciler: a dropped socket may have missed
   * invalidations, so we re-diff from scratch on reconnect. Returns an
   * unsubscribe.
   */
  onReconnect(handler: () => void): () => void;
  stop(): void;
}

const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Capped exponential backoff: 1s, 2s, 4s, ... clamped to `maxBackoffMs`.
 * Exported for the backoff unit test; matches server/desktop backoff shape.
 */
export function computeBackoffDelay(attempt: number, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS): number {
  return Math.min(1000 * 2 ** attempt, maxBackoffMs);
}

export function startServerWs(options: ServerWsClientOptions): ServerWsClient {
  const { serverUrl, apiKey, machineId, logger } = options;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/ws`;

  const invalidateHandlers = new Map<string, Set<InvalidateHandler>>();
  const eventHandlers = new Map<string, Set<EventHandler>>();
  const reconnectHandlers = new Set<() => void>();

  let socket: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let stopped = false;
  // The initial connect is not a "reconnect"; only opens after the first fire
  // the reconnect handlers.
  let hasConnectedOnce = false;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = computeBackoffDelay(attempt, maxBackoffMs);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const dispatch = (raw: unknown) => {
    let parsed: WsServerMessage;
    try {
      parsed = JSON.parse(String(raw)) as WsServerMessage;
    } catch {
      return; // malformed frames dropped, matching the server's rule
    }
    if (parsed.type === "invalidate") {
      for (const handler of invalidateHandlers.get(parsed.table) ?? []) handler(parsed);
    } else if (parsed.type === "event") {
      for (const handler of eventHandlers.get(parsed.event) ?? []) handler(parsed);
    }
  };

  const connect = () => {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { headers: { "x-api-key": apiKey } });
    } catch (error) {
      logger.error?.(`[hitch] server WS failed to start: ${String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.on("open", () => {
      attempt = 0;
      // Re-hello on EVERY (re)connect: the server registry is per-socket and
      // dropped on close, so a reconnect must re-register this machine.
      ws.send(JSON.stringify({ type: "hello", machineId }));
      logger.info(`[hitch] server WS connected (${wsUrl}); hello sent for machine ${machineId}`);
      if (hasConnectedOnce) {
        for (const handler of reconnectHandlers) {
          try {
            handler();
          } catch {
            // A reconnect handler must never break the socket.
          }
        }
      }
      hasConnectedOnce = true;
    });
    ws.on("message", (data) => dispatch(data.toString()));
    // 'error' is always followed by 'close'; reconnect once, from 'close'.
    ws.on("error", () => {});
    ws.on("close", () => {
      if (socket === ws) socket = null;
      scheduleReconnect();
    });
  };

  const register = <H>(map: Map<string, Set<H>>, key: string, handler: H): (() => void) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<H>();
      map.set(key, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  };

  connect();

  return {
    onInvalidate: (table, handler) => register(invalidateHandlers, table, handler),
    onEvent: (event, handler) => register(eventHandlers, event, handler),
    onReconnect: (handler) => {
      reconnectHandlers.add(handler);
      return () => {
        reconnectHandlers.delete(handler);
      };
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = socket;
      socket = null;
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
