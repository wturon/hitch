import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The electron main module is not available under vitest's node env — stub it
// with an ipcMain that just records the registered handlers so the test can
// invoke sign-in / sign-out directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

// initHitchServer reads process.env.HITCH_SERVER_URL at call time, so set it
// before importing (the import itself is side-effect-free beyond the mock).
const { initHitchServer } = await import("../hitchServer.js");
import type { HitchServerCredentials } from "../hitchServer.js";

const SERVER_URL = "http://localhost:9999";

// A no-op WebSocket so startWs()'s connect() doesn't throw in node env.
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  constructor(_url: string, _opts?: unknown) {}
  send() {}
  close() {}
}

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/auth/sign-in/email")) {
      return {
        ok: true,
        headers: { getSetCookie: () => ["session=abc"] },
        json: async () => ({}),
      } as unknown as Response;
    }
    if (url.endsWith("/api/auth/api-key/create")) {
      return { ok: true, json: async () => ({ id: "key-1", key: "secret-key" }) } as unknown as Response;
    }
    if (url.endsWith("/api/auth/api-key/delete")) {
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("hitchServer sign-in/out daemon seam", () => {
  let stored: HitchServerCredentials | null;
  let onSignIn: ReturnType<typeof vi.fn>;
  let onSignOut: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;
  const origWs = globalThis.WebSocket;

  beforeEach(() => {
    handlers.clear();
    stored = null;
    onSignIn = vi.fn();
    onSignOut = vi.fn();
    process.env.HITCH_SERVER_URL = SERVER_URL;
    globalThis.fetch = fakeFetch();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

    initHitchServer({
      getStoredCredentials: () => stored,
      setStoredCredentials: (creds) => {
        stored = creds;
      },
      getWindow: () => null,
      log: () => {},
      onSignIn,
      onSignOut,
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWs;
    delete process.env.HITCH_SERVER_URL;
  });

  it("starts the daemon exactly once on a successful sign-in", async () => {
    const signIn = handlers.get("hitch-server:sign-in");
    expect(signIn).toBeDefined();

    const result = (await signIn?.({}, { email: "a@b.c", password: "pw" })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    // Credentials were persisted, so startDaemon would find them.
    expect(stored?.apiKey).toBe("secret-key");
    // The daemon start callback fired exactly once (not on next boot, not twice).
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("stops the daemon on sign-out", async () => {
    // Sign in first so there are credentials to revoke.
    await handlers.get("hitch-server:sign-in")?.({}, { email: "a@b.c", password: "pw" });
    onSignIn.mockClear();

    await handlers.get("hitch-server:sign-out")?.({});
    expect(stored).toBeNull();
    expect(onSignOut).toHaveBeenCalledTimes(1);
    // Sign-out never re-triggers a daemon start.
    expect(onSignIn).not.toHaveBeenCalled();
  });
});
