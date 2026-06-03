# Hitch

A realtime sync layer that couples AI agents and humans to the same view of work — so a fast-growing pile of work stays in step instead of drifting apart.

## The idea

Coding agents are great at reading and writing files in a repo. But task/status files committed to a repo get locked to a branch, which makes human review and collaboration awkward. Hitch decouples **task state** (fast, branch-agnostic, realtime) from **code state** (slow, branch-bound, git):

- A **git-ignored folder** (e.g. `.hitch/`) lives in your repo's working directory. Because it's untracked, it sits at the same path regardless of which branch is checked out.
- **Agents write greppable files** into that folder — their progress and context — using the file access they're already good at. No MCP required.
- A **local daemon** watches the folder and syncs it, in real time, to a shared backend.
- A **desktop app** runs the daemon and renders those files live as a Kanban board, so humans can read and collaborate at the task level without checking out a branch.

## Architecture (v0)

- **Backend:** [Convex](https://convex.dev) — reactive store + functions; handles realtime push, consistency, and reconnection. No separate server.
- **Daemon:** a Node runtime that watches `.hitch/`, hashes files, pushes changes to Convex, and writes incoming changes back to disk (with echo suppression so a synced write doesn't loop).
- **Desktop UI:** an Electron app with a Vite/React renderer subscribing to live Convex queries and supervising the daemon.

### v0 conventions

- **One writer per file.** Each agent owns its own file (named by owner/task), which keeps whole-file last-write-wins correct and defers conflict-resolution complexity.
- File format stays loose for now (Markdown + frontmatter is the likely default); structured primitives can come later.

## Status

Early. The local development target is the Electron desktop app.

## Local Development

Run Convex and Hitch Desktop in separate terminals:

```sh
npm run dev:convex
npm run dev
```

For GitHub sign-in in the desktop renderer, the Convex Auth site URL should be:

```sh
npx convex env set SITE_URL http://127.0.0.1:5173
```

The `.cmux` Hitch Desktop Dev command runs Convex, the Vite renderer, and
Electron in separate tabs for easier log scanning. `npm run dev:all` is still
available when you want a single combined terminal.

## Production Readiness

See [docs/production-readiness.md](docs/production-readiness.md) for the current
deployment checklist, required environment variables, and the remaining auth /
project gaps before broad sharing.
