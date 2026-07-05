# Hitch — AGENTS.md

Hitch is a **local file sync engine**. A daemon watches git-ignored `.hitch/`
folders and keeps them in sync, in real time, with a Convex backend — so AI
agents and humans share one live view of in-progress work without committing it
to git.

## Layout

- `convex/` — backend, deploys to Convex cloud (no server we host):
  - `files.ts` — `upsertFile` (create/update/tombstone), `listFiles`, `getFile`
  - `status.ts` — `heartbeat` (daemon presence), `listDaemons`
  - `schema.ts` — `files` and `daemons` tables
- `daemon/` — TypeScript (`src/index.ts`, run via `tsx`) Node watcher: pushes
  local file changes up to Convex and writes remote changes back to disk, with
  echo suppression so a synced write never loops.
- `desktop/` — Electron app with the canonical Vite/React todos workspace
  (grouped todo list) and local daemon controls.
- `hitch.config.json` — the active project + which local paths are hitched.

---

## Verifying UI changes (Electron)

`desktop/e2e/` lets you drive the real app under Playwright to check UI work
end-to-end — click buttons, type, assert focus/caret, take screenshots. It
launches a **second, isolated** Electron instance: its own Chromium profile
(`--user-data-dir`) and its own Hitch config (so its daemon stays idle and never
touches your project sync), seeded with your signed-in `secrets.json` so it
boots authenticated as you. Your running dev app keeps the auth-loopback port;
the test instance just logs a benign "port in use" and skips sign-in.

- Prereq: `npm run dev:renderer` running (serves the renderer on :5173).
- `desktop/e2e/harness.mjs` exports `launchHitch()` → `{ app, page, cleanup }`.
- `npm run e2e` (in `desktop/`) runs the example task-editor check.

These are **one-off checks, not a maintained suite** — write a throwaway script,
run it, read the screenshots in `/tmp/hitch-e2e/`, delete it. Confine any edits
to a scratch task you create and delete.
