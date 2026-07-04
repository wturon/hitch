import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { applyTheme, getStoredTheme, watchSystemTheme } from "./lib/theme";

// The inline script in index.html sets the initial `.dark` class to avoid a
// flash; re-apply here to push the mode to the main process and keep tracking
// the OS theme while on "system".
applyTheme(getStoredTheme());
watchSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexClientProvider>
      <App />
    </ConvexClientProvider>
  </StrictMode>,
);
