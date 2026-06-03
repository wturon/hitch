"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import {
  ConvexAuthProvider,
  useAuthActions,
  type TokenStorage,
} from "@convex-dev/auth/react";
import {
  HITCH_CONVEX_URL,
  missingConvexUrlMessage,
} from "@/lib/config";

function createAuthStorage(): TokenStorage {
  const bridge =
    typeof window !== "undefined"
      ? (
          window as Window & {
            hitchDaemon?: {
              getAuthStorageItem: (key: string) => Promise<string | null>;
              setAuthStorageItem: (key: string, value: string) => Promise<void>;
              removeAuthStorageItem: (key: string) => Promise<void>;
            };
          }
        ).hitchDaemon
      : undefined;

  if (bridge) {
    return {
      getItem: (key) => bridge.getAuthStorageItem(key),
      setItem: (key, value) => bridge.setAuthStorageItem(key, value),
      removeItem: (key) => bridge.removeAuthStorageItem(key),
    };
  }

  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
}

// After the system-browser OAuth round-trip, the main process delivers the
// authorization code over IPC (the renderer is loaded from file:// and never
// receives it in its URL). We feed it to Convex Auth here, inside the provider so
// `useAuthActions` is available. The exchange must pass `provider: undefined` so
// the server takes its code-verification branch — passing a provider alongside a
// code restarts OAuth instead. This mirrors what the library does internally for
// code-from-URL (client.js); the public type only exposes the `provider: string`
// form, hence the cast.
function AuthCallbackBridge() {
  const { signIn } = useAuthActions();
  useEffect(() => {
    const bridge =
      typeof window !== "undefined"
        ? (
            window as Window & {
              hitchDaemon?: {
                onAuthCallback?: (
                  cb: (payload: { code?: string; error?: string }) => void,
                ) => () => void;
              };
            }
          ).hitchDaemon
        : undefined;
    if (!bridge?.onAuthCallback) return;
    const completeSignIn = signIn as unknown as (
      provider: undefined,
      params: { code: string },
    ) => Promise<unknown>;
    return bridge.onAuthCallback(({ code, error }) => {
      if (error) {
        console.error("Hitch sign-in failed:", error);
        return;
      }
      if (code) void completeSignIn(undefined, { code });
    });
  }, [signIn]);
  return null;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // One client for the whole app. Created lazily in the browser — Convex's
  // reactive queries run over a WebSocket the client owns.
  const [convex] = useState(() =>
    HITCH_CONVEX_URL ? new ConvexReactClient(HITCH_CONVEX_URL) : null,
  );
  const authStorage = useMemo(() => createAuthStorage(), []);

  if (!convex) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="text-lg font-semibold">Hitch is not configured</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {missingConvexUrlMessage()}
        </p>
      </main>
    );
  }

  return (
    <ConvexAuthProvider
      client={convex}
      storage={authStorage}
      replaceURL={(relativeUrl) => {
        window.history.replaceState({}, "", relativeUrl);
      }}
    >
      <AuthCallbackBridge />
      {children}
    </ConvexAuthProvider>
  );
}
