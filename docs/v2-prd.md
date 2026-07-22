# Hitch V2 — PRD & Progress Tracker

> Working doc for Claude's orchestration of the V2 build. This file is self-sufficient: everything
> needed to execute lives here. Review artifacts (visual mirrors of this content, same info):
> [plan](https://claude.ai/code/artifact/510af568-780c-41f9-b5aa-4aecf12dfebc) ·
> [schema](https://claude.ai/code/artifact/e7151e66-78d2-4756-ace8-c19640ed710c).
> Durable memory: `hitch-v2-architecture`. All design decisions CLOSED 2026-07-22 (M0 ✓).

## Thesis

AI-native Todoist: personal task management with a delegation layer. Assign work to agents
(claude/codex on the user's subscriptions, running in cmux); quickly find and resume their chats.
Loops deferred to 2.1. Will's core goal: empty mental RAM fast, push work to agents easily,
let agents pull from / enrich the backlog.

## Decided architecture (do not relitigate)

- **Server (Railway):** Hono (Node) + vanilla Postgres + Drizzle + better-auth. Owns ALL state and
  all logic that doesn't need a machine. Boring on purpose: no harness opinions, no cmux awareness
  server-side, ever.
- **Automations/crons: AXED from V2** (no table, no scheduler; 2.1+ if ever).
- **Everything flows through the server, in exactly two forms — never a stored command queue:**
  - STATE (open/close/delegate/stop) = declarative rows (`assignments.desired_state`), reconciled by daemon.
  - EVENTS (focus; later pings) = ephemeral WS pub/sub relay via server. No table, no persistence,
    no retry; undelivered events evaporate. Litmus test: "can the daemon verify it from ground truth
    afterward?" yes → state row; no → event.
  - Speed model: "deliver the wake-up twice, never the command twice" — rows are the only truth;
    WS notify just says "look now". ~30s reconcile tick is the fallback. Enables phone→focus-Mac later.
- **Delegation:** `assignments` row = one handoff of a task to an agent on a machine. Covers:
  spawn-new (no chat yet), adopt-existing-chat (created with chat_id set, already satisfied),
  re-assign (new row; old rows = history). Append-only.
- **Single-creator-per-table rule:** assignments created by client (intent); chats created by daemon
  (observation); daemon links assignment→chat at spawn. Merging them = the PR #48 two-writers wedge.
- **Daemon = pure reconciler:** reacts to server (WS push + ~30s tick), diffs desired vs machine
  ground truth (cmux/processes), executes spawn/resume/kill/observe, writes ONLY observations.
  Local state = disposable cache. NO business timers.
- **Client (Electron):** reads server only, writes intent + events only. Never talks to the machine
  directly — focus goes client → server WS relay → daemon → cmux (~100-150ms accepted).
- **Realtime:** pg LISTEN/NOTIFY (triggers on every table) → `@hono/node-ws` broadcast
  `{table, id}` → TanStack Query invalidateQueries → refetch. Reconnect = refetch everything
  (missed messages harmless). Researched: canonical TkDodo pattern; sync engines rejected
  (Zero = Convex-shaped lock-in); ElectricSQL/TanStack DB adoptable later without rewrite.
- **Blobs:** Railway Buckets (S3 API; same project, $0.015/GB, free ops+egress). Garage in self-host
  compose (MinIO unmaintained/dead since late 2025). Store S3 KEYS in DB, never URLs; presigned
  upload/download; size caps enforced at finalize-time (presigned URLs can't enforce). R2 = env-var
  swap fallback (has CDN if public serving ever matters). rclone migration = ~1hr.
- **Auth:** better-auth in first pass. Email/password to start; api-key plugin for CLI + daemon.
  Single `requireAuth` middleware. Desktop can reuse OAuth-loopback pattern later (port 51789 precedent).
- **Agent access:** self-teaching `hitch` CLI (npm workspace bin). `--help` + errors written FOR
  agents (task-oriented examples, exact flags); `--json` for scripting. No required skill file.
  MCP later if wanted. (Precedent: Todoist recommends CLI over MCP for Claude Code.)
- **Packaging:** monorepo (npm workspaces, root package.json exists). Dockerfile (~10 lines,
  node:22-slim) — Railway builds it; docker-compose.yml (server + postgres:16 + Garage) = self-host
  story. DB never in app image; `DATABASE_URL` is the only coupling.
- **Kill list (at M5, after cutover):** convex/ (all 21 modules), task file sync + chokidar watchers,
  `.hitch/tasks` markdown format, files/attachments/backlogOrders concepts, Convex command bus.
- **Keep:** daemon chat lifecycle + observer (daemon/src/observer, feeds observed_state), cmux
  launchers (daemon/src/launchers, cmux.ts), skills index, markdown editor (desktop/src/renderer/editor,
  ~3.5k LOC — task bodies live in the UI), snippets (become prompt templates).

## Schema v1 (CLOSED — build exactly this in Drizzle)

Conventions: uuidv7 PKs everywhere; `sort_order` = fractional-index strings (Figma-style);
`created_at`/`updated_at` timestamptz, updated_at via trigger; NOTIFY trigger on every table.
better-auth manages its own tables (user, session, account, apikey) — omitted here.
All user-data tables carry `user_id` FK → better-auth user.

**Intent tables (written by client/CLI):**
- `projects`: id, user_id, name, repo_path? (⚠ machine-specific on shared table — fine at 1 machine;
  becomes project_paths(project_id, machine_id, path) join if 2nd machine appears), sort_order
- `sections`: id, project_id FK, name, sort_order
- `tasks`: id, project_id? FK, section_id? FK, title, body (markdown, VERBATIM — capture text is
  sacred, never transform), status `open|done` ONLY (todos-v1 lesson: no manual statuses; agent
  activity lives on assignments/chats), sort_order, created_at, updated_at, completed_at?
- `tags`: id, user_id, name unique-per-user, color (named tint); `task_tags`: (task_id, tag_id) PK
- `comments`: id, task_id FK, author_kind `user|agent`, assignment_id? FK (when agent), body, created_at
- `attachments`: id, task_id?/comment_id? (exactly one), key (S3), filename, mime, size, sha256,
  state `pending|finalized`

**Execution tables:**
- `assignments` (task↔agent with lifecycle): id, task_id FK, machine_id FK, harness `claude|codex`,
  prompt? (from snippet), desired_state `running|stopped` [client-written],
  reviewed_at? [client-written; attention-queue ack],
  observed_state `pending|spawning|running|waiting_input|done|dead` [DAEMON-ONLY],
  chat_id? FK [daemon sets at spawn], worktree? [daemon], created_at, updated_at
- `chats` (daemon-created; can exist task-free for ad-hoc): id, machine_id FK, project_id?,
  harness, title (auto-named), cmux_ref jsonb, status `busy|waiting_input|idle|dead`,
  last_activity_at — ALL columns daemon-written
- `machines`: id, user_id, name ("wills-mbp"), daemon_version, last_seen_at (heartbeat)

**Attention queue** = query: `assignments where observed_state='waiting_input'` ∪
`observed_state='done' and reviewed_at is null`.

## Environment status (2026-07-22)

- ✅ Convex prod export DONE: `backups/convex-prod-export-2026-07-22.zip` (gitignored). Verified:
  both users present (abroccolo16@gmail.com = the other user, wturon1@gmail.com = Will). Task data
  is in `files/documents.jsonl` (1.7MB — tasks are file rows in Convex's file-sync model).
  Her data is safe; nothing is irreversible anymore.
- ✅ Docker Desktop running on Will's Mac.
- ⏳ Railway: NOT set up. Will must run `! railway login` when we reach deploy (step 8); then Claude
  creates project + Postgres + Bucket via CLI.

## Repo context

Monorepo root `/Users/willturon/code/hitch` (npm workspaces): `desktop/` (Electron, 33k LOC,
Convex live queries today), `daemon/` (12.5k LOC; chatLifecycle*, observer/, launchers/, cmux.ts,
runner.ts), `convex/` (4.3k LOC, dies at M5), `scripts/`, `docs/`. Root AGENTS.md explains e2e
harness (desktop/e2e launchHitch — real app, signed-in, isolated; USE IT to verify UI).
Current git: main. Build on branch `feat/v2-server`. Do not break V1 while building V2 —
in-place migration, V1 keeps working until cutover.

New packages to create: `server/` (Hono app), `shared/` (exported types + hono client), later
`cli/` (hitch bin). Wire into root workspaces.

## Milestones

- [x] **M0 — All decisions closed** (2026-07-22)
- [ ] **M1 — Server up** (each step ≈ a PR-able chunk):
  1. Workspace scaffold: `server/` + `shared/` packages
  2. Drizzle schema + migrations (exactly the spec above) + NOTIFY/updated_at triggers
  3. Hono CRUD + zod validation + typed client export (`hc<AppType>` from shared/)
  4. better-auth: email/password + api-key plugin; single requireAuth middleware
  5. WS layer: LISTEN/NOTIFY → invalidation broadcast; ephemeral event relay (focus)
  6. Dockerfile + docker-compose (server + postgres:16 + Garage); attachments presigned flow
  7. Importer: `.hitch/tasks/*.md` frontmatter+body + Convex export zip → Postgres; --dry-run flag;
     throwaway (deleted at M5)
  8. Railway deploy (needs Will: `railway login`)
  Verify locally: docker compose up + vitest + curl against routes; WS notify observed via test client.
- [ ] **M2 — Desktop on server:** TanStack Query + WS invalidation replaces Convex queries; editor
  binds to server task bodies; attachments UI via presigned URLs. Verify via desktop/e2e harness.
- [ ] **M3 — CLI:** `hitch` bin end-to-end with a real agent chat.
- [ ] **M4 — Daemon reconciler:** desired/observed loop, spawn-on-assign, machine registration +
  heartbeat, chat-state relay, focus relay handling. Remove file sync + Convex push from daemon.
  Assign UX decided here (D5 — rip from existing dialog/snippets surfaces).
- [ ] **M5 — Cutover + delete:** real import, one week of real V2 use, then delete convex/ + task
  files + sync machinery. (Prod export already banked — see Environment status.)

## Still-open (deferred, not blockers)

- D5 assign-time UX — decide at M4.
- D6 chat-monitoring hardening (ground-truth backstop under hooks) — carved-out separate workstream.
- projects.repo_path multi-machine normalization — when a 2nd machine appears.

## Progress log

- 2026-07-21 — PRD created; architecture decided. D2 (in-place), D3 (import = TASKS ONLY: title,
  body verbatim, tags, sections, order, open/done), D4 (downtime OK; export prod first) closed.
- 2026-07-22 — Automations AXED. No-command-bus model settled (state=rows, events=WS relay).
  `runs` renamed `assignments`. D1/schema closed → **M0 complete**.
- 2026-07-22 — Convex prod export banked + verified + gitignored. Docker confirmed running.
  Ready to start M1 step 1 on branch `feat/v2-server`. (Conversation compacted after this point.)
