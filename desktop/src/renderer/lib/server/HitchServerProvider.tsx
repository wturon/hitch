import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  getHitchServerBridge,
  type HitchServerAuthResult,
  type HitchServerBridge,
} from "./bridge";
import { createServerClient, type HitchClient } from "./client";
import { startRealtimeInvalidation } from "./realtime";

interface HitchServerContextValue {
  serverUrl: string;
  /** null until getApiKey resolves once — gates the sign-in flash on boot. */
  authReady: boolean;
  /** Signed in iff non-null. */
  client: HitchClient | null;
  /**
   * Main-held WS connectivity: true = open, false = closed/refused, null =
   * no verdict yet (boot, before the first open — so the unreachable banner
   * never flashes during the initial handshake).
   */
  wsConnected: boolean | null;
  signIn: (input: { email: string; password: string }) => Promise<HitchServerAuthResult>;
  signUp: (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<HitchServerAuthResult>;
  signOut: () => Promise<void>;
}

const HitchServerContext = createContext<HitchServerContextValue | null>(null);

export function useHitchServer(): HitchServerContextValue {
  const value = useContext(HitchServerContext);
  if (!value) {
    throw new Error("useHitchServer must be used inside HitchServerProvider");
  }
  return value;
}

// The V2 data-layer root: one QueryClient for the app, the WS→invalidation
// subscription, and auth state (API key present or not) for the shell.
export function HitchServerProvider({
  serverUrl,
  children,
}: {
  serverUrl: string;
  children: ReactNode;
}) {
  const bridge = getHitchServerBridge();
  const [queryClient] = useState(() => new QueryClient());
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.getApiKey().then((key) => {
      if (cancelled) return;
      setApiKey(key);
      setAuthReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return startRealtimeInvalidation(queryClient, bridge);
  }, [bridge, queryClient]);

  // WS connectivity for the unreachable banner. The pull only ever upgrades
  // null → true: a `false` at boot could just mean "handshake in flight", but
  // a pushed `false` is a real close/refusal and always lands.
  const [wsConnected, setWsConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.getWsStatus().then((connected) => {
      if (cancelled || !connected) return;
      setWsConnected((prev) => prev ?? true);
    });
    const off = bridge.onWsStatus((connected) => {
      if (!cancelled) setWsConnected(connected);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);

  const refreshApiKey = useCallback(async (target: HitchServerBridge) => {
    setApiKey(await target.getApiKey());
  }, []);

  const value = useMemo<HitchServerContextValue>(() => {
    const missingBridge: HitchServerAuthResult = {
      ok: false,
      error: "Hitch server bridge unavailable",
    };
    return {
      serverUrl,
      authReady,
      client: apiKey ? createServerClient(serverUrl, apiKey) : null,
      wsConnected,
      async signIn(input) {
        if (!bridge) return missingBridge;
        const result = await bridge.signIn(input);
        if (result.ok) await refreshApiKey(bridge);
        return result;
      },
      async signUp(input) {
        if (!bridge) return missingBridge;
        const result = await bridge.signUp(input);
        if (result.ok) await refreshApiKey(bridge);
        return result;
      },
      async signOut() {
        await bridge?.signOut();
        setApiKey(null);
        // Back to "no verdict": the sign-out close is deliberate, and the next
        // sign-in's handshake shouldn't start under a stale disconnected flag.
        setWsConnected(null);
        queryClient.clear();
      },
    };
  }, [serverUrl, authReady, apiKey, wsConnected, bridge, refreshApiKey, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <HitchServerContext.Provider value={value}>{children}</HitchServerContext.Provider>
    </QueryClientProvider>
  );
}
