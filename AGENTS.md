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
- `web/` — deprecated Next.js scaffold; keep changes focused on `desktop/`.
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

## Source control
- No branching. Push everything straight to `main`
