// Hitch server integration for the Electron main process.
//
// The server URL is resolved before this runs (HITCH_SERVER_URL in dev, or the
// baked app-config.json in a packaged build — see main.ts). All server-facing
// main-process concerns live here; main.ts only injects its secrets accessors +
// window getter via initHitchServer().
//
// Responsibilities:
//   - Auth: sign-in/sign-up run HERE (Node fetch, no Origin header, so the
//     better-auth endpoints see a non-CORS request). The session cookie from
//     set-cookie is used once, to mint an API key, then discarded. Only
//     {serverUrl, apiKey, apiKeyId} persist (secrets.json, `hitchServer` key).
//   - The /ws connection is held HERE, not in the renderer: browser WebSocket
//     can't send the x-api-key header, and a main-held socket survives renderer
//     reloads. Server messages are forwarded verbatim over
//     "hitch-server:ws-message"; each (re)connect emits "hitch-server:ws-open"
//     so the renderer can refetch everything it may have missed.
import { hostname } from "node:os";
import { ipcMain, type BrowserWindow } from "electron";

export interface HitchServerCredentials {
  serverUrl: string;
  apiKey: string;
  /** better-auth api-key row id — needed to delete the key on sign-out. */
  apiKeyId?: string;
}

export interface HitchServerConfig {
  serverUrl: string;
}

interface HitchServerDeps {
  getStoredCredentials: () => HitchServerCredentials | null;
  setStoredCredentials: (creds: HitchServerCredentials | null) => void;
  getWindow: () => BrowserWindow | null;
  log: (stream: "system" | "stderr", message: string) => void;
  // Called after a successful in-session sign-in (credentials persisted, WS up)
  // so the host can start the reconciler daemon that sat idle while signed out —
  // otherwise the daemon only starts on the NEXT app boot. Idempotent on the
  // host side (startDaemon's `if (daemon)` guard), so there's never two.
  onSignIn?: () => void;
  // Called after sign-out (credentials cleared, WS down) so the host can stop the
  // daemon, which would otherwise keep authenticating with a now-revoked key.
  onSignOut?: () => void;
}

type AuthResult = { ok: true } | { ok: false; error: string };

// Node's global WebSocket (undici) accepts a non-standard options bag with
// custom headers — verified on the Node 24 that Electron 42 embeds. The DOM
// lib typings don't know about it, hence this constructor type.
type NodeWebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export function getHitchServerConfig(): HitchServerConfig | null {
  const serverUrl = process.env.HITCH_SERVER_URL?.trim();
  return serverUrl ? { serverUrl: serverUrl.replace(/\/+$/, "") } : null;
}

export function initHitchServer(deps: HitchServerDeps): void {
  const config = getHitchServerConfig();

  // Stored credentials only count when they were minted against the server
  // this launch is pointed at — a stale key for another deployment is not
  // "signed in".
  const activeCredentials = (): HitchServerCredentials | null => {
    if (!config) return null;
    const creds = deps.getStoredCredentials();
    return creds && creds.serverUrl === config.serverUrl ? creds : null;
  };

  // ---------------------------------------------------------------------------
  // WebSocket (main-held, capped exponential backoff)
  // ---------------------------------------------------------------------------

  let socket: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let wsEnabled = false;
  let wsConnected = false;
  const WS_OPEN = 1; // WebSocket.OPEN

  // Send a client message (e.g. a focus event) up the main-held socket. The
  // renderer can't hold the api-key'd socket itself, so it hands the frame to
  // main via IPC — the events half of the PRD's two-forms model (ephemeral,
  // no ack; a closed socket just drops it). Returns whether it was sent.
  const wsSend = (message: unknown): boolean => {
    if (!socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      deps.log("stderr", `Hitch server WS send failed: ${String(error)}`);
      return false;
    }
  };

  // Connectivity truth for the renderer's unreachable banner: broadcast on
  // every transition, and answerable on demand (a reloaded renderer asks via
  // get-ws-status rather than waiting for the next transition).
  const setWsConnected = (value: boolean) => {
    if (wsConnected === value) return;
    wsConnected = value;
    deps.getWindow()?.webContents.send("hitch-server:ws-status", value);
  };

  const scheduleReconnect = () => {
    if (!wsEnabled || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (!wsEnabled || !config) return;
    const creds = activeCredentials();
    if (!creds) return;
    const wsUrl = `${config.serverUrl.replace(/^http/, "ws")}/ws`;
    let ws: WebSocket;
    try {
      const Ctor = globalThis.WebSocket as unknown as NodeWebSocketCtor;
      ws = new Ctor(wsUrl, { headers: { "x-api-key": creds.apiKey } });
    } catch (error) {
      deps.log("stderr", `Hitch server WS failed to start: ${String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      setWsConnected(true);
      deps.getWindow()?.webContents.send("hitch-server:ws-open");
    };
    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // malformed frames are dropped, matching the server's rule
      }
      deps.getWindow()?.webContents.send("hitch-server:ws-message", parsed);
    };
    // 'error' is always followed by 'close'; reconnect once, from onclose.
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
        setWsConnected(false);
      }
      scheduleReconnect();
    };
  };

  const startWs = () => {
    if (wsEnabled) return;
    wsEnabled = true;
    attempt = 0;
    connect();
  };

  const stopWs = () => {
    wsEnabled = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = socket;
    socket = null;
    setWsConnected(false);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  };

  // ---------------------------------------------------------------------------
  // Auth (better-auth over Node fetch)
  // ---------------------------------------------------------------------------

  const authErrorMessage = async (response: Response): Promise<string> => {
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message) return body.message;
    } catch {
      /* non-JSON error body */
    }
    return `Request failed (${response.status})`;
  };

  // better-auth's CSRF check rejects POSTs with a missing/null Origin, so
  // every /api/auth/* call sends the server's own origin (always in
  // trustedOrigins — it's the baseURL). Node fetch, unlike a browser, lets us
  // set it. Data routes (hc + x-api-key) don't need this.
  const authHeaders = (extra: Record<string, string>): Record<string, string> => ({
    "Content-Type": "application/json",
    origin: config?.serverUrl ?? "",
    ...extra,
  });

  // Runs the shared tail of sign-in and sign-up: take the session cookie from
  // the auth response, mint an API key with it, persist the key, drop the
  // cookie on the floor, and bring the WS up.
  const completeSignIn = async (authResponse: Response): Promise<AuthResult> => {
    if (!config) return { ok: false, error: "Not running in server mode" };
    const cookies = authResponse.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .filter(Boolean);
    if (cookies.length === 0) {
      return { ok: false, error: "Sign-in succeeded but returned no session cookie" };
    }
    const cookie = cookies.join("; ");
    const createResponse = await fetch(`${config.serverUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: authHeaders({ cookie }),
      body: JSON.stringify({ name: `desktop ${hostname()}` }),
    });
    if (!createResponse.ok) {
      return { ok: false, error: await authErrorMessage(createResponse) };
    }
    const created = (await createResponse.json()) as { id?: unknown; key?: unknown };
    if (typeof created.key !== "string" || !created.key) {
      return { ok: false, error: "API key creation returned no key" };
    }
    deps.setStoredCredentials({
      serverUrl: config.serverUrl,
      apiKey: created.key,
      apiKeyId: typeof created.id === "string" ? created.id : undefined,
    });
    deps.log("system", `Signed in to Hitch server at ${config.serverUrl}`);
    startWs();
    // Start the reconciler daemon now (it was idle without credentials at boot),
    // rather than waiting for the next app launch.
    deps.onSignIn?.();
    return { ok: true };
  };

  const authenticate = async (
    path: "/api/auth/sign-in/email" | "/api/auth/sign-up/email",
    body: Record<string, string>,
  ): Promise<AuthResult> => {
    if (!config) return { ok: false, error: "Not running in server mode" };
    try {
      const response = await fetch(`${config.serverUrl}${path}`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify(body),
      });
      if (!response.ok) return { ok: false, error: await authErrorMessage(response) };
      return await completeSignIn(response);
    } catch (error) {
      return { ok: false, error: `Could not reach the server: ${String(error)}` };
    }
  };

  const signOut = async (): Promise<void> => {
    const creds = activeCredentials();
    stopWs();
    deps.setStoredCredentials(null);
    if (!config || !creds?.apiKeyId) return;
    // Best-effort server-side revocation — the key authenticates its own
    // deletion (the api-key plugin resolves x-api-key into a session).
    try {
      await fetch(`${config.serverUrl}/api/auth/api-key/delete`, {
        method: "POST",
        headers: authHeaders({ "x-api-key": creds.apiKey }),
        body: JSON.stringify({ keyId: creds.apiKeyId }),
      });
    } catch {
      /* offline sign-out still clears local creds */
    }
    deps.log("system", "Signed out of Hitch server");
    // Stop the daemon: its api key was just revoked, so leaving it running would
    // only produce 401s until the next boot.
    deps.onSignOut?.();
  };

  // ---------------------------------------------------------------------------
  // IPC surface (window.hitchServer in the preload)
  // ---------------------------------------------------------------------------

  ipcMain.handle("hitch-server:get-config", () => config);
  ipcMain.handle("hitch-server:get-api-key", () => activeCredentials()?.apiKey ?? null);
  ipcMain.handle("hitch-server:get-ws-status", () => wsConnected);
  ipcMain.handle("hitch-server:ws-send", (_event, message: unknown) => wsSend(message));
  ipcMain.handle(
    "hitch-server:sign-in",
    (_event, input: { email: string; password: string }) =>
      authenticate("/api/auth/sign-in/email", {
        email: input.email,
        password: input.password,
      }),
  );
  ipcMain.handle(
    "hitch-server:sign-up",
    (_event, input: { email: string; password: string; name: string }) =>
      authenticate("/api/auth/sign-up/email", {
        email: input.email,
        password: input.password,
        name: input.name,
      }),
  );
  ipcMain.handle("hitch-server:sign-out", () => signOut());

  if (config && activeCredentials()) startWs();
}
