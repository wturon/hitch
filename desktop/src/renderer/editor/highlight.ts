// Syntax highlighting for the code block's Notion-style overlay. A `<pre>` from
// Shiki renders behind an invisible textarea (see CodeBlockNode); this module is
// the single, lazily-created Shiki highlighter that turns code → colored HTML.
//
// INVARIANTS this module upholds for the overlay:
//   - The highlighter is created ONCE, on first use, via a dynamic `import()`.
//     The editor must render and be fully editable BEFORE (and without) the
//     highlighter — plain, un-highlighted code is both the loading state and the
//     permanent fallback for unknown/lang-less fences. Nothing here is on the
//     critical render path; `codeToHtml` is only ever called after the async load
//     resolves (guarded by `getHighlighter()` returning null until then).
//   - Fine-grained bundle: `createHighlighterCore` + the JavaScript regex engine
//     + an explicit lang/theme list, NOT the full `shiki` bundle. Only the
//     languages the dropdown offers are pulled in. The JS engine (no WASM) keeps
//     this working in Node/jsdom for tests and avoids shipping onig.wasm.
//   - Shiki HTML is fed to the pre via dangerouslySetInnerHTML. This is safe:
//     Shiki escapes the code text (e.g. `<` → `&#x3C;`, `&` → `&#x26;`, `"` →
//     `&#x22;`) — the only HTML it emits is its own <span> token markup, never
//     anything derived unescaped from user input.
import type { HighlighterCore } from "shiki/core";

// Our dropdown's short language names (LANGUAGE_OPTIONS in CodeBlockNode) → Shiki
// grammar ids. A fence language absent from this map (including "" / a lang-less
// fence, or any raw info-string the document happens to carry) highlights as
// plain text — never a throw. Keep this in lock-step with LANGUAGE_OPTIONS and
// with LOADED_LANGS below (every mapped id must be in the loaded set).
const LANG_MAP: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  python: "python",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  sql: "sql",
  html: "html",
  css: "css",
  rust: "rust",
  go: "go",
  markdown: "markdown",
};

// Dual theme: GitHub Light/Dark. Chosen because their token palettes read well
// on the block's `bg-muted` surface in both modes, and their own backgrounds are
// suppressed (we render with `defaultColor: false`, so the pre carries only
// `--shiki-light`/`--shiki-dark` CSS vars and no concrete color/background — the
// block keeps its own surface, and styles.css wires the vars to `color`, flipping
// on the root `.dark` class).
export const LIGHT_THEME = "github-light";
export const DARK_THEME = "github-dark";

// Resolve a fence language to a loaded Shiki id, or null for plain text.
export function shikiLang(language: string): string | null {
  return LANG_MAP[language] ?? null;
}

let highlighter: HighlighterCore | null = null;
let loadPromise: Promise<HighlighterCore> | null = null;
const readyListeners = new Set<() => void>();

// Kick off (once) the async creation of the highlighter. Idempotent: concurrent
// callers share the same promise, and once resolved every ready-listener fires so
// mounted code blocks re-render from plain → highlighted.
function loadHighlighter(): Promise<HighlighterCore> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
    // Each lang/theme module's grammar/theme is its default export.
    const langs = await Promise.all([
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/jsx.mjs"),
      import("shiki/langs/python.mjs"),
      import("shiki/langs/bash.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/sql.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/rust.mjs"),
      import("shiki/langs/go.mjs"),
      import("shiki/langs/markdown.mjs"),
    ]);
    const themes = await Promise.all([
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ]);
    const hl = await createHighlighterCore({
      langs: langs.map((m) => m.default),
      themes: themes.map((m) => m.default),
      engine: createJavaScriptRegexEngine(),
    });
    highlighter = hl;
    for (const fn of readyListeners) fn();
    return hl;
  })();
  return loadPromise;
}

// The highlighter if it has finished loading, else null (and, on the first null,
// starts the load). Callers render plain code while this is null.
export function getHighlighter(): HighlighterCore | null {
  if (!highlighter) void loadHighlighter();
  return highlighter;
}

// Subscribe to the one-shot "highlighter is ready" event. Returns an unsubscribe.
// If the highlighter is already loaded, the caller never needs this.
export function onHighlighterReady(fn: () => void): () => void {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

// Highlight `code` for `language` to Shiki HTML, or return null to fall back to
// plain text (highlighter not loaded yet, unknown/lang-less fence, or a Shiki
// throw). Sync once the highlighter is loaded — small blocks, called per render.
export function highlightToHtml(code: string, language: string): string | null {
  const hl = getHighlighter();
  if (!hl) return null;
  const lang = shikiLang(language);
  if (!lang) return null;
  try {
    return hl.codeToHtml(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      // No concrete color/background on the output — only `--shiki-light` /
      // `--shiki-dark` vars, wired to `color` in styles.css so the block keeps
      // its own surface and the tokens flip with the root `.dark` class.
      defaultColor: false,
      // The pre is a decorative sizer under the textarea; strip Shiki's
      // tabindex so it never becomes a tab stop.
      transformers: [
        {
          pre(node) {
            delete node.properties.tabindex;
          },
        },
      ],
    });
  } catch {
    return null;
  }
}

// Test seam: reset the module singleton so a mock/highlighter can be re-observed.
export function __resetHighlighterForTests(): void {
  highlighter = null;
  loadPromise = null;
  readyListeners.clear();
}
