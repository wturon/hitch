// Theme handling for Hitch Desktop.
//
// shadcn/Tailwind drive dark mode off a `.dark` class on <html>. We persist the
// user's choice in localStorage and toggle that class ourselves so a manual
// Light/Dark/System control can override the OS preference. "System" tracks the
// OS via matchMedia. The initial paint is handled by an inline script in
// index.html (see applyThemeFromStorage) to avoid a flash before React mounts.

export type ThemeMode = "light" | "dark" | "system";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

const STORAGE_KEY = "hitch.theme";

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

export function getStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemeMode(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

// Mirror the resolved theme onto the document and let the main process keep the
// native window background in sync (so the title bar / launch flash match).
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;

  const bridge = (
    window as unknown as {
      hitchDaemon?: { setNativeTheme?: (mode: ThemeMode) => unknown };
    }
  ).hitchDaemon;
  void bridge?.setNativeTheme?.(mode);
}

export function setTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode / disabled storage: still apply for this session.
  }
  applyTheme(mode);
}

// Re-apply when the OS theme changes, but only while the user is on "system".
// Returns an unsubscribe function.
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getStoredTheme() === "system") applyTheme("system");
  };
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}
