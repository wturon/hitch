# Hitch

AI-native task management with a delegation layer. Capture tasks, assign them to
agents (claude/codex on your own subscriptions, running in cmux), and quickly
find and resume their chats.

## The idea

Empty your mental RAM fast, push work to agents easily, and let agents pull from
and enrich the backlog. A task is a small markdown doc; delegating it hands it to
an agent on one of your machines, which runs the chat and reports back so you can
review and resume without hunting through terminals.

## Architecture

- **Server** ([`server/`](server)) — [Hono](https://hono.dev) + Postgres +
  Drizzle + [better-auth](https://better-auth.com). Owns **all** state and any
  logic that doesn't need a machine. Realtime via Postgres `LISTEN/NOTIFY` →
  WebSocket invalidation. Deployed on [Railway](https://railway.app); runnable
  locally with `docker compose`.
- **Desktop** ([`desktop/`](desktop)) — Electron app (Vite/React renderer). Reads
  and writes the server only; the main process holds auth (an api key minted at
  sign-in) and the server WebSocket.
- **Daemon** ([`daemon/`](daemon)) — a **pure reconciler**. It reacts to the
  server (WS push + a ~30s tick), diffs desired vs. machine ground truth
  (cmux/processes), spawns/resumes/closes agent chats via the cmux launchers, and
  writes back only observations.
- **CLI** ([`cli/`](cli)) — a self-teaching `hitch` bin agents use to read and
  write the backlog. **Shared** ([`shared/`](shared)) — types + the typed hono
  client used across desktop/cli/daemon.

Design decisions and the schema live in [docs/v2-prd.md](docs/v2-prd.md).

## Local Development

Bring up the server (Postgres + Hono) and point the desktop app at it:

```sh
docker compose up -d --build          # server on :3010
npm run dev:v2-stack                  # composed stack + a dev api key
HITCH_SERVER_URL=http://localhost:3010 npm run dev:desktop
```

`npm run dev:all` runs the server stack and the desktop app in one combined
terminal. See [AGENTS.md](AGENTS.md) for the e2e harness and the fake-launch
daemon loop.

## Deployment

The server deploys to Railway from its Dockerfile (`railway up`). Packaged
desktop builds bake the prod server URL into `app-config.json`
(`HITCH_SERVER_URL` at package time); the build fails closed if it's unset.
