import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { applyTheme, getStoredTheme, watchSystemTheme } from "./lib/theme";
import { getHitchServerBridge } from "./lib/server/bridge";
import { HitchServerProvider } from "./lib/server/HitchServerProvider";
import AppV2 from "./v2/AppV2";

// The inline script in index.html sets the initial `.dark` class to avoid a
// flash; re-apply here to push the mode to the main process and keep tracking
// the OS theme while on "system".
applyTheme(getStoredTheme());
watchSystemTheme();

// Mode switch (V2, M2 PR 1): the main process reports a server URL iff it was
// launched with HITCH_SERVER_URL — then the V2 shell mounts against the Hono
// server. Otherwise the V1 (Convex) tree renders exactly as before.
async function boot() {
  const serverConfig = await getHitchServerBridge()
    ?.getConfig()
    .catch(() => null);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {serverConfig ? (
        <HitchServerProvider serverUrl={serverConfig.serverUrl}>
          <AppV2 />
        </HitchServerProvider>
      ) : (
        <ConvexClientProvider>
          <App />
        </ConvexClientProvider>
      )}
    </StrictMode>,
  );
}

void boot();
