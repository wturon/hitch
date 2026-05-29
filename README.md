# Hitch

A realtime sync layer that couples AI agents and humans to the same view of work — so a fast-growing pile of work stays in step instead of drifting apart.

## The idea

Coding agents are great at reading and writing files in a repo. But task/status files committed to a repo get locked to a branch, which makes human review and collaboration awkward. Hitch decouples **task state** (fast, branch-agnostic, realtime) from **code state** (slow, branch-bound, git):

- A **git-ignored folder** (e.g. `.hitch/`) lives in your repo's working directory. Because it's untracked, it sits at the same path regardless of which branch is checked out.
- **Agents write greppable files** into that folder — their progress and context — using the file access they're already good at. No MCP required.
- A **local daemon** watches the folder and syncs it, in real time, to a shared backend.
- A **web UI** renders those files live (kanban, list, whatever) so humans can read and collaborate at the task level without checking out a branch.

## Architecture (v0)

- **Backend:** [Convex](https://convex.dev) — reactive store + functions; handles realtime push, consistency, and reconnection. No separate server.
- **Daemon:** a Node CLI that watches `.hitch/`, hashes files, pushes changes to Convex, and writes incoming changes back to disk (with echo suppression so a synced write doesn't loop).
- **Web UI:** a small React app subscribing to a live Convex query.

### v0 conventions

- **One writer per file.** Each agent owns its own file (named by owner/task), which keeps whole-file last-write-wins correct and defers conflict-resolution complexity.
- File format stays loose for now (Markdown + frontmatter is the likely default); structured primitives can come later.

## Status

Early. Sketching the Convex schema + functions and the daemon.
