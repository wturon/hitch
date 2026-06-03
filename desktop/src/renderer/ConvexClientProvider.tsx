"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import {
  ConvexAuthProvider,
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
      {children}
    </ConvexAuthProvider>
  );
}
