# Production Readiness

This is the checklist for sharing the simplest Hitch desktop build with other
engineers.

## Current Deployable Shape

- Convex is the backend. Deploy one Convex instance per environment.
- Hitch Desktop runs locally on each machine that owns a watched `.hitch/`
  folder. Its Electron main process supervises the daemon, and its Vite/React
  renderer shows the live Kanban board.
- Auth and project access notes live in [auth.md](auth.md).

## Required Configuration

Desktop app / local daemon:

- `hitch.config.json`
  - `activeProject`: project slug, for example `will-default`
  - `hitches`: one or more project/local-path bindings
- `.env` or `.env.local`
  - `CONVEX_URL`: optional when `npx convex dev` writes `CONVEX_DEPLOYMENT`
  - `HITCH_DEVICE_TOKEN`: user/device-scoped token used by the local daemon

Renderer:

- `NEXT_PUBLIC_CONVEX_URL`: Convex deployment URL
- `NEXT_PUBLIC_HITCH_PROJECT`: project id to render

Run `npm run check` before deploying. It typechecks the daemon and desktop app,
then builds the desktop renderer.

## Local Dev Setup

1. `npm install`
2. `npx convex dev` once to create/login to a dev deployment.
3. Add `HITCH_DEVICE_TOKEN` to `.env.local` until Desktop can mint/store it
   automatically. `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_HITCH_PROJECT` are
   optional overrides for the renderer.
4. Run `npm run dev:convex` and `npm run dev` in separate terminals, or use the
   `.cmux` Hitch Dev command for split logs.
5. Create or edit a file under a watched `.hitch/` folder and confirm it appears
   on the board.

## Production Gaps Before Broad Sharing

- Authentication is partially implemented with Convex Auth. Production still
  needs final project membership/backfill and device-token onboarding before
  untrusted users can access it.
- Project discovery is manual. The desktop board uses one configured project id;
  there is no project picker or invite flow yet.
- Command execution is trusted-local. Browser commands are executed by matching
  local daemons, so the command queue should stay limited to trusted users until
  auth and command authorization exist.
- File content is plaintext in Convex. Do not sync secrets, credentials, or
  private customer data until data handling expectations are defined.
- Conflict handling is still "one writer per file" and last-write-wins.

## Operational Checks

- Confirm the daemon heartbeat appears in `status.listDaemons`.
- Confirm local edits sync to Convex and remote edits write back to disk.
- Confirm deletes create tombstones and remove the local file on other machines.
- Confirm a board-created task is written back to the local `.hitch/` folder.
- Confirm Codex/Claude launch commands are only enabled where a trusted local
  daemon is running.
