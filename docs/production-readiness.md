# Production Readiness

This is the checklist for sharing the simplest hosted Hitch board with other
engineers.

## Current Deployable Shape

- Convex is the backend. Deploy one Convex instance per environment.
- The daemon runs locally on each machine that owns a watched `.hitch/` folder.
- The web board can be deployed as a static/Next app when configured with the
  same Convex URL and workspace id as the daemon.

## Required Configuration

Local daemon:

- `hitch.config.json`
  - `workspace`: shared board id, for example `will-default`
  - `watch`: one or more `{ "label": "...", "path": "./.hitch" }` entries
- `.env` or `.env.local`
  - `CONVEX_URL`: optional when `npx convex dev` writes `CONVEX_DEPLOYMENT`

Web board:

- `NEXT_PUBLIC_CONVEX_URL`: Convex deployment URL
- `NEXT_PUBLIC_HITCH_WORKSPACE`: workspace id to render

Run `npm run check` before deploying. It typechecks daemon and web, runs the web
linter, and builds the web app.

## Local Dev Setup

1. `npm install`
2. `npx convex dev` once to create/login to a dev deployment.
3. Add `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_HITCH_WORKSPACE` to
   `.env.local` for the web board.
4. `npm run dev`
5. Create or edit a file under a watched `.hitch/` folder and confirm it appears
   on the board.

## Production Gaps Before Broad Sharing

- Authentication is not implemented yet. Convex functions currently trust the
  caller-provided `workspace`, so a production deployment must add auth and
  workspace membership checks before untrusted users can access it.
- Workspace discovery is manual. The web board uses one configured workspace id;
  there is no workspace picker or invite flow yet.
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
- Confirm a web-created task is written back to the local `.hitch/` folder.
- Confirm Codex/Claude launch commands are only enabled where a trusted local
  daemon is running.
