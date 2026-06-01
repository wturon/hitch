# Hitch Desktop

Electron app for Hitch's local daemon and Kanban board.

## Development

From the repo root:

```sh
npm run dev:desktop
```

The desktop app starts a Vite-powered React renderer, opens an Electron window
with the live Kanban board, and automatically spawns the daemon runner process
via:

```sh
node ./node_modules/tsx/dist/cli.mjs daemon/src/runner.ts
```

The daemon runner imports `@hitch/daemon`'s reusable runtime and reports status
and logs to Electron over process IPC. The renderer talks to Electron through a
narrow preload IPC bridge so the board can configure local hitches, read status,
stream logs, and start or stop the daemon without direct Node access.

On first launch, the app creates a local daemon config at:

```text
~/Library/Application Support/Hitch/config.json
```

In development, that file is seeded from the repo's `hitch.config.json`. The
local config stores machine-specific hitches: project, optional project display
name, local path, and whether the hitch is enabled. The daemon derives the
watched `.hitch` directory from each local path.
