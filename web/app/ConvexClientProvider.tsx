"use client";

import { useState, type ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import {
  HITCH_CONVEX_URL,
  missingConvexUrlMessage,
} from "@/lib/config";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // One client for the whole app. Created lazily in the browser — Convex's
  // reactive queries run over a WebSocket the client owns.
  const [convex] = useState(() =>
    HITCH_CONVEX_URL ? new ConvexReactClient(HITCH_CONVEX_URL) : null,
  );

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
      replaceURL={(relativeUrl) => {
        window.history.replaceState({}, "", relativeUrl);
      }}
    >
      {children}
    </ConvexAuthProvider>
  );
}
