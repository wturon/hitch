// Typed view of the preload's window.hitchServer bridge (see
// src/preload/preload.cts). Kept as a standalone declaration — the renderer
// can't import from the preload build — mirroring how V1 components declare
// their window.hitchDaemon slices.

export interface HitchServerConfig {
  serverUrl: string;
}

export type HitchServerAuthResult = { ok: true } | { ok: false; error: string };

export interface HitchServerBridge {
  getConfig: () => Promise<HitchServerConfig | null>;
  getApiKey: () => Promise<string | null>;
  signIn: (input: { email: string; password: string }) => Promise<HitchServerAuthResult>;
  signUp: (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<HitchServerAuthResult>;
  signOut: () => Promise<void>;
  wsSend: (message: unknown) => Promise<boolean>;
  onWsMessage: (callback: (message: unknown) => void) => () => void;
  onWsOpen: (callback: () => void) => () => void;
  getWsStatus: () => Promise<boolean>;
  onWsStatus: (callback: (connected: boolean) => void) => () => void;
}

declare global {
  interface Window {
    hitchServer?: HitchServerBridge;
    // The preload's local-daemon bridge (harness setup, updater, spellcheck,
    // clipboard, theme, …). Each consumer narrows it with its own cast, so an
    // opaque type here is enough to keep the global surface honest.
    hitchDaemon?: unknown;
  }
}

export function getHitchServerBridge(): HitchServerBridge | undefined {
  return typeof window !== "undefined" ? window.hitchServer : undefined;
}
