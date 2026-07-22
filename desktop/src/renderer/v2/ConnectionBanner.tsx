import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CloudOffIcon } from "lucide-react";

import { useHitchServer } from "@/lib/server/HitchServerProvider";

// The server-unreachable banner (M2 PR 7): a slim, non-blocking pill floating
// just under the titlebar. It shows when the workspace has lost the server —
// the main-held WS is down, or any live query has exhausted its retries — and
// dismisses itself on real recovery (WS open again AND every errored query
// refetched successfully). One quiet surface, no toast spam: connectivity is
// app-state, not an event feed.
//
// While unhealthy it also drives the "retrying" it advertises: errored
// TanStack queries don't refetch on their own (retries exhausted, no focus
// event in a frameless Electron window), so a slow poll re-runs exactly the
// errored ones. WS recovery is the other half — reconnect invalidates
// everything (realtime.ts), which is what clears the error states below.
const RETRY_INTERVAL_MS = 5_000;
// Unhealthy state must persist this long before the banner appears, so a
// sub-second WS blip (sign-in handshake, a single dropped frame) never
// flashes chrome at the user.
const SHOW_DELAY_MS = 600;

// True while any query in the cache is in error state — the "queries are
// failing" half of the banner condition, kept live via the cache's own
// subscription.
function useAnyQueryError(queryClient: QueryClient): boolean {
  const [hasError, setHasError] = useState(false);
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const compute = () =>
      setHasError(cache.getAll().some((query) => query.state.status === "error"));
    compute();
    return cache.subscribe(compute);
  }, [queryClient]);
  return hasError;
}

export function ConnectionBanner() {
  const { wsConnected } = useHitchServer();
  const queryClient = useQueryClient();
  const anyQueryError = useAnyQueryError(queryClient);

  // wsConnected === null is "no verdict yet" (boot/handshake) — only a
  // definite close counts as unhealthy.
  const unhealthy = wsConnected === false || anyQueryError;

  // Debounced visibility: unhealthy arms a timer; healthy clears instantly.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!unhealthy) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [unhealthy]);

  // The retry loop, alive only while unhealthy: refetch just the errored
  // queries. (A down WS with no errored queries needs no HTTP retries — the
  // main process owns that socket's backoff.)
  useEffect(() => {
    if (!unhealthy) return;
    const timer = setInterval(() => {
      void queryClient.refetchQueries({
        predicate: (query) => query.state.status === "error",
      });
    }, RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [unhealthy, queryClient]);

  if (!visible) return null;

  return (
    <div
      role="status"
      data-testid="v2-connection-banner"
      className="fixed left-1/2 top-14 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3.5 py-1.5 text-[12px] text-muted-foreground shadow-sm"
    >
      <CloudOffIcon className="size-3.5" aria-hidden />
      Can’t reach server — retrying
    </div>
  );
}
