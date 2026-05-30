"use client";

import { type ReactNode } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";

// One client for the whole app. Created in a "use client" module so it lives
// only in the browser — Convex's reactive queries run over a WebSocket the
// client owns, so there's nothing to render on the server.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
