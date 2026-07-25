# Hitch — AGENTS.md

Hitch is **AI-native task management with a delegation layer**: capture tasks,
assign them to agents (claude/codex on your subscriptions, running in cmux), and
quickly find and resume their chats. A Hono server owns all state; the desktop
app reads/writes it; a reconciler daemon executes the machine-side work.

> **Architecture note (V2, the only architecture):** the legacy Convex file-sync
> engine (V1) was deleted at the cutover. If you find references to `convex/`,
> `.hitch/tasks` markdown sync, device tokens, or "hitched folders" in old docs
> or memories, they describe the dead V1 world — ignore them.

## Layout

- `server/` — Hono (Node) + Postgres + Drizzle + better-auth. Owns ALL state and
  logic that doesn't need a machine. Deployed on Railway (prod) and runnable via
  `docker compose`. See `docs/v2-prd.md` for the schema and design decisions.
- `shared/` — exported types + typed hono client shared by desktop/cli/daemon.
- `cli/` — the self-teaching `hitch` bin agents use to read/write the backlog.
- `daemon/` — a **pure reconciler** (`src/index.ts` via `tsx`; `src/v2/`): it
  reacts to the server (WS push + ~30s tick), diffs desired vs. machine ground
  truth (cmux/processes), spawns/resumes/closes agent chats via the cmux
  launchers, and writes back ONLY observations. Chat tracking lives in
  `src/observer/`: every tick it derives the WHOLE working set from the machine
  (Claude pidfiles, Codex's thread catalog, the process table) and PUTs it to
  `/daemon/machines/:id/chat-snapshot` — a chat missing from the snapshot is no
  longer live, which is the entire heal path, and that PUT is the **only** writer
  of a chat row anywhere. It keeps **no chat model**: hooks drop JSON files into
  `<appSupport>/events/` (drained and deleted), and `cursors.json` +
  `launches.json` are the only persistent local state, disposable by design.
  `src/attachment/` is the one place that knows about launches: it pre-registers
  a chat we started (claude's session id is known up front, codex's isn't), joins
  a codex thread to its launch by cmux surface id, and links the assignment to
  the chat row the snapshot echoes back. Observation must never import it, or
  `launchers/`, or `cmux.ts` —
  `npm -w @hitch/daemon run smoke:observer-boundary` enforces that. See
  `docs/chat-tracking-redesign.md`.
- `desktop/` — Electron app. Renderer entry `src/renderer/main.tsx` mounts
  `src/renderer/v2/AppV2.tsx`; the main process (`src/main/`) holds auth (api key
  minted after sign-in) and the server WebSocket. Reads/writes the server only.
  In dev, **⌘⌥I opens the Chat Inspector** (`src/renderer/inspector/`) — a second
  window on the same bundle (`?view=inspector`) that renders the whole chat
  pipeline as a pure server read. It is the instrument for debugging anything
  above: read its health strip first, because a stale snapshot makes every row
  below it fiction.
- The server URL comes from `HITCH_SERVER_URL` in dev, or the baked
  `app-config.json` (Railway prod) in a packaged build.

---

## Verifying UI changes (Electron)

`desktop/e2e/` lets you drive the real app under Playwright to check UI work
end-to-end — click buttons, type, assert focus/caret, take screenshots. It
launches a **second, isolated** Electron instance: its own Chromium profile
(`--user-data-dir`) and its own isolated app-support dir, so its daemon never
touches your real data.

The app is server-backed: point a check at a running server via
`HITCH_SERVER_URL`. Bring up the compose stack first, then run a check — each
signs **up** against the fresh stack, so no seeded credentials are needed:

```sh
docker compose up -d --build   # repo root; server on :3010
HITCH_SERVER_URL=http://localhost:3010 node desktop/e2e/check-v2-todos-read.mjs
docker compose down -v         # wipe when done (including data)
```

- `desktop/e2e/harness.mjs` exports `launchHitch()` → `{ app, page, cleanup }`.
- The `desktop/e2e/check-v2-*.mjs` scripts are the working examples.

These are **one-off checks, not a maintained suite** — write a throwaway script,
run it, read the screenshots in `/tmp/hitch-e2e/`, delete it. Confine any edits
to a scratch task you create and delete.

### V2 daemon e2e (fake-launch mode)

The reconcile loop (delegate → chat → done) can be exercised with **no cmux and
no agent binary** by running the daemon under `HITCH_FAKE_LAUNCH=1`: it swaps the
real launchers for cmux-less stand-ins that script a chat's OBSERVATION AXES
(running+working, then a completed turn → running+idle → `waiting_input`, then
gone on close) into the attachment layer, so they ride the same snapshot PUT a
real chat does and the server derives the same statuses. Point it at a scratch
dir with `HITCH_APP_SUPPORT_DIR` so it never touches your real local state. Fake
sessions write no transcript/pidfile/thread, so real discovery never sees them
and nothing can contradict the script (heal-proof by construction). Knobs:
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
