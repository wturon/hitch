# Hitch Desktop

Electron app for Hitch — the task workspace and the local reconciler daemon.

## Development

Point the app at a running Hitch server (see the repo-root README for bringing up
the compose stack), then from the repo root:

```sh
HITCH_SERVER_URL=http://localhost:3010 npm run dev:desktop
```

The desktop app starts a Vite-powered React renderer, opens an Electron window
with the task workspace, and automatically spawns the daemon runner process via:

```sh
node ./node_modules/tsx/dist/cli.mjs daemon/src/runner.ts
```

The daemon runner imports `@hitch/daemon`'s reconciler runtime and reports status
and logs to Electron over process IPC. The renderer never talks to a machine
directly — it reads and writes the server, and the main process holds the api key
(minted at sign-in) and the server WebSocket. In a packaged build the server URL
comes from the baked `app-config.json`; in dev it comes from `HITCH_SERVER_URL`.
Auth credentials live in:

```text
~/Library/Application Support/Hitch/secrets.json
```

The renderer's current project comes from the authenticated server project list.

## Beta distribution and updates

For the first install, build the signed/notarized DMG and share it directly.
That is enough to onboard a beta user.

For iterative updates, use GitHub Releases as the update host:

1. Commit the changes you want to ship.
2. Add release notes to `CHANGELOG.md` under a `## [<version>] - YYYY-MM-DD`
   heading.
3. Run from the repo root:

   ```sh
   npm run release:desktop -- 0.1.1
   ```

The release script:

- loads `.env.production` for signing/notarization credentials
- uses `GITHUB_RELEASE_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`
  for GitHub publishing
- updates `desktop/package.json` and `package-lock.json` to the requested
  version
- commits the version bump
- tags and pushes `v<version>` to `main`
- builds the signed/notarized DMG + zip artifacts
- publishes the GitHub Release assets and auto-update metadata
- copies the matching `CHANGELOG.md` section into the GitHub Release notes

The generated GitHub Release page is also the initial install link. Send the
release URL to a beta user and have them download the DMG. After that first
install, the app checks GitHub Releases shortly after startup. Hitch asks before
it downloads an available update, then asks again before restarting to install
it.

If something goes wrong with auto-update, the fallback is still manual: send the
same GitHub Release link and have the beta user download the newer DMG.
