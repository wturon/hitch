import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { applyTheme, getStoredTheme, watchSystemTheme } from "./lib/theme";
import { getHitchServerBridge } from "./lib/server/bridge";
import { HitchServerProvider } from "./lib/server/HitchServerProvider";
import AppV2 from "./v2/AppV2";

// The inline script in index.html sets the initial `.dark` class to avoid a
// flash; re-apply here to push the mode to the main process and keep tracking
// the OS theme while on "system".
applyTheme(getStoredTheme());
watchSystemTheme();

// V2 is the only app now (V1/Convex deleted at the cutover). The main process
// resolves the server URL — from HITCH_SERVER_URL in dev, or the baked
// app-config.json (Railway prod) in a packaged build — so this always mounts.
async function boot() {
  const serverConfig = await getHitchServerBridge()
    ?.getConfig()
    .catch(() => null);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <HitchServerProvider serverUrl={serverConfig?.serverUrl ?? ""}>
        <AppV2 />
      </HitchServerProvider>
    </StrictMode>,
  );
}

void boot();
