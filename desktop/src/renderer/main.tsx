import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { applyTheme, getStoredTheme, watchSystemTheme } from "./lib/theme";
import { getHitchServerBridge } from "./lib/server/bridge";
import { HitchServerProvider } from "./lib/server/HitchServerProvider";
import InspectorApp from "./inspector/InspectorApp";
import AppV2 from "./v2/AppV2";

// The inline script in index.html sets the initial `.dark` class to avoid a
// flash; re-apply here to push the mode to the main process and keep tracking
// the OS theme while on "system".
applyTheme(getStoredTheme());
watchSystemTheme();

// Which view this window is. One bundle serves every BrowserWindow; the main
// process appends `?view=` when it opens a non-default one (see main.ts
// rendererTarget). Today the only extra view is the dev-only Chat Inspector
// (docs/chat-tracking-redesign.md §9) — a second window on this same bundle,
// which is why there is no second Vite entry point and no second HTML file.
// Anything unrecognised falls through to the product, so a stray query string
// can never strand a user on a debug screen.
function viewFromLocation(search: string): "inspector" | "app" {
  return new URLSearchParams(search).get("view") === "inspector" ? "inspector" : "app";
}

// V2 is the only app now (V1/Convex deleted at the cutover). The main process
// resolves the server URL — from HITCH_SERVER_URL in dev, or the baked
// app-config.json (Railway prod) in a packaged build — so this always mounts.
async function boot() {
  const serverConfig = await getHitchServerBridge()
    ?.getConfig()
    .catch(() => null);

  const view = viewFromLocation(window.location.search);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {/* Both views share ONE provider: same QueryClient contract, same
          main-held WS invalidations, same auth. The Inspector is a different
          window, not a different data layer. */}
      <HitchServerProvider serverUrl={serverConfig?.serverUrl ?? ""}>
        {/* import.meta.env.DEV is a build-time constant, so in a packaged
            build this whole branch is dead code and the Inspector is dropped
            from the bundle — not merely unreachable. The main process gates
            the window on `isDev` too; this is the second lock. */}
        {import.meta.env.DEV && view === "inspector" ? <InspectorApp /> : <AppV2 />}
      </HitchServerProvider>
    </StrictMode>,
  );
}

void boot();
