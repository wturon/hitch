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
- `web/` — (later) a live board UI. Not built yet.
- `hitch.config.json` — the workspace id + which `.hitch/` folders to watch.

## Run

1. `npm install`
2. `npx convex dev` once (logs you in + creates a dev deployment). Copy the
   printed deployment URL into `.env` as `CONVEX_URL=https://...convex.cloud`.
3. `npm run dev` — runs Convex and the daemon together.
4. Drop a file into a watched `.hitch/` folder; it appears in Convex within ~1s,
   and changes made elsewhere are written back to disk.

## Conventions

- **One writer per file** — each agent owns its own file, so whole-file
  last-write-wins is safe and we avoid conflict resolution for now.
- `.hitch/` is **git-ignored**; never commit it.
- Text / Markdown files only for now.

---

## Source control
- No branching. Push everything straight to `main`
