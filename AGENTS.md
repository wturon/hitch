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
- `desktop/` — Electron app with the canonical Vite/React Kanban board and
  local daemon controls.
- `hitch.config.json` — the active project + which local paths are hitched.

## Run

1. `npm install`
2. `npx convex dev` once (logs you in + creates a dev deployment).
3. Add `HITCH_DEVICE_TOKEN` to `.env.local` until Desktop mints/stores it
   automatically.
4. `npm run dev` — runs Hitch Desktop; keep `npm run dev:convex` running in a
   separate terminal or use the `.cmux` Hitch Dev command for split logs.
5. Drop a file into a watched `.hitch/` folder; it appears in Convex within ~1s,
   and changes made elsewhere are written back to disk.

## Conventions

- **One writer per file** — each agent owns its own file, so whole-file
  last-write-wins is safe and we avoid conflict resolution for now.
- `.hitch/` is **git-ignored**; never commit it.
- Text / Markdown files only for now.

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

---

## Source control
- No branching. Push everything straight to `main`
