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

### Driving V2 (server mode)

Setting `HITCH_SERVER_URL` at launch flips the app into the V2 shell (Hono
server instead of Convex) — the harness passes it through unchanged. Bring up
the compose stack first, then point a check at it:

```sh
docker compose up -d --build   # repo root; server on :3010
HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-todos-read.mjs
docker compose down -v         # wipe when done (including data)
```

V2 checks sign **up** against the fresh stack, so the seeded dev secrets don't
matter (V1's daemon still stays idle). The `desktop/e2e/check-v2-*.mjs` scripts
are the working examples.

### V2 daemon e2e (fake-launch mode)

The reconcile loop (delegate → chat → done) can be exercised with **no cmux and
no agent binary** by running the daemon under `HITCH_FAKE_LAUNCH=1`: it swaps the
real launchers for cmux-less stand-ins that script the chat lifecycle
(bound→working, then a completed turn→`waiting_input`, then `session.ended` on
close) straight into the shared store. Point the store at a scratch dir with
`HITCH_APP_SUPPORT_DIR` so it never touches the real `chat-lifecycle.sqlite`.
Fake sessions write no transcript/pidfile, so the observer's dead-process heal
can never touch them (heal-proof by construction). Knobs:
`HITCH_FAKE_LAUNCH_DELAY_MS` (bind→turn delay), `HITCH_RECONCILE_MS`.

```sh
docker compose up -d --build                 # server on :3010
node scripts/dev-v2-stack.mjs                # compose + fake daemon; prints an api key
node daemon/scripts/v2-fake-loop.mjs         # headless full-loop check (pending→…→done)
docker compose down -v                       # wipe when done
```

`scripts/dev-v2-stack.mjs` (`npm run dev:v2-stack`) brings the whole thing up for
hand-driven curl; `daemon/scripts/v2-fake-loop.mjs` is the disposable acceptance
check (the fake analogue of `daemon/scripts/v2-reconciler-real-machine.mjs`).
