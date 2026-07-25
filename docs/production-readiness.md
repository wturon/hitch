# Production Readiness

> **⚠️ ARCHIVED — describes the deleted V1 (Convex) architecture.** V2 runs on a
> Hono + Postgres server deployed to Railway; packaged desktop builds bake the
> prod server URL into `app-config.json`. See [v2-prd.md](v2-prd.md) (Environment
> status + Deployment) for the current shape. Kept only as historical context.

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
  - `hitches`: zero or more project-id/local-path bindings
  - `projectId`: Convex project document id for a binding
  - `localPath`: local folder whose `.hitch/` directory is synced
- `.env` or `.env.local`
  - `CONVEX_URL`: optional when `npx convex dev` writes `CONVEX_DEPLOYMENT`
  - `HITCH_DEVICE_TOKEN`: user/device-scoped token used by the local daemon

Renderer:

- `NEXT_PUBLIC_CONVEX_URL`: Convex deployment URL
- Projects are loaded from the authenticated user's Convex project list; no
  project env var is used.

Run `npm run check` before deploying. It typechecks the daemon and desktop app,
then builds the desktop renderer.

## Packaging the macOS desktop app

Hitch Desktop is packaged with [electron-builder](https://www.electron.build)
into a signed, notarized `.dmg` for **Apple Silicon (arm64)**. Auto-update is not
wired up yet — distribute new `.dmg`s manually for now.

What the package step does (`desktop/electron-builder.yml`):

- Builds the main process + Vite renderer (`npm run build`).
- Bundles the daemon into one self-contained `dist-daemon/runner.js` via esbuild
  (`scripts/bundle-daemon.mjs`). chokidar 5 has no native deps, so the bundle is
  portable; it ships outside the asar at `Resources/daemon/runner.js` and runs
  under Electron's own Node (`ELECTRON_RUN_AS_NODE`).
- Writes `dist-daemon/app-config.json` with the prod Convex URL
  (`scripts/gen-app-config.mjs`); it ships at `Resources/app-config.json` and the
  main process passes it to the daemon as `CONVEX_URL`.
- Produces `desktop/release/Hitch-<version>-arm64.dmg`.

### One-time prerequisites

- A **Developer ID Application** signing certificate in your login keychain
  (from the Apple Developer Program). Verify with `security find-identity -v -p codesigning`.
- `desktop/build/icon.icns` (gitignored build artifact). If missing, the build
  falls back to the default Electron icon. (The icon-generation pipeline is
  maintained separately.)

### Build environment variables

Set these in the shell that runs the package step (never commit them):

- `NEXT_PUBLIC_CONVEX_URL` and `CONVEX_URL` — the **prod** Convex deployment URL
  (`npx convex deploy` first). The renderer bakes `NEXT_PUBLIC_CONVEX_URL` at Vite
  build time; `CONVEX_URL` is baked into `app-config.json` for the daemon.
- Notarization (read by `@electron/notarize`): `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

### Run it

```sh
npx convex deploy                 # deploy the prod backend (manual)
CONVEX_URL=https://<prod>.convex.cloud \
NEXT_PUBLIC_CONVEX_URL=https://<prod>.convex.cloud \
APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... \
  npm run package:desktop
```

To smoke-test the pipeline without signing (produces an unsigned, un-notarized
`.dmg` that macOS will warn on):

```sh
cd desktop && CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac --arm64 -c.mac.notarize=false -c.mac.identity=null
```

### Verify the result

```sh
APP="desktop/release/mac-arm64/Hitch.app"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vvv -t install "$APP"     # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"        # expect: The validate action worked
```

Then copy `Hitch.app` to `/Applications` and launch it: it should open with no
Gatekeeper warning, and the in-app daemon log should report the daemon idle
("No projects hitched yet") on a fresh install. Add a project, paste a device
token, and confirm a file in `.hitch/` syncs to the prod Convex deployment.

## Local Dev Setup

1. `npm install`
2. `npx convex dev` once to create/login to a dev deployment.
3. Add `HITCH_DEVICE_TOKEN` to `.env.local` until Desktop can mint/store it
   automatically. `NEXT_PUBLIC_CONVEX_URL` is an optional override for the
   renderer.
4. Run `npm run dev:convex` and `npm run dev` in separate terminals, or use the
   `.cmux` Hitch Dev command for split logs.
5. Create or edit a file under a watched `.hitch/` folder and confirm it appears
   on the board.

## Production Gaps Before Broad Sharing

- Authentication is partially implemented with Convex Auth. Production still
  needs final project membership/backfill and device-token onboarding before
  untrusted users can access it.
- Project discovery comes from Convex Auth membership. There is a project picker,
  but no invite flow yet.
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
