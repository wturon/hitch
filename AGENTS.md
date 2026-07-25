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
  launchers, and writes back ONLY observations. Chat lifecycle lives in
  `src/observer/` + the shared sqlite store; it holds no business state.
- `desktop/` — Electron app. Renderer entry `src/renderer/main.tsx` mounts
  `src/renderer/v2/AppV2.tsx`; the main process (`src/main/`) holds auth (api key
  minted after sign-in) and the server WebSocket. Reads/writes the server only.
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
