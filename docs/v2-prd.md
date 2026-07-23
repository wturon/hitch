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
- [ ] **M1 — Server up** (steps 1–7 DONE 2026-07-22, PRs #86–#92; step 8 pending):
  1. [x] Workspace scaffold (PR #86)
  2. [x] Drizzle schema + migrations + NOTIFY/updated_at triggers (PR #87)
  3. [x] Hono CRUD + zod + typed client (PR #88)
  4. [x] better-auth email/password + api-key (PR #89)
  5. [x] WS layer: invalidation broadcast + ephemeral event relay (PR #90)
  6. [x] Dockerfile + compose (server+postgres:16+Garage) + attachments presigned flow (PR #91)
  7. [x] Importer with --dry-run default (PR #92)
  8. [ ] Railway deploy (needs Will: `railway login`; then create project + Postgres + Bucket via
     CLI, set BETTER_AUTH_SECRET/URL + S3_* env, deploy from server/Dockerfile, run a smoke curl)
  All local verification done: 50 server tests (Docker-backed postgres+Garage), composed-stack
  curl transcript (sign-up→task→upload→download), WS invalidate + relay observed by test clients.
- [x] **M2 — Desktop on server** (DONE 2026-07-22, PRs #93–#100; plan + per-PR detail in
  docs/v2-m2-plan.md): parallel V2 shell behind runtime mode switch (`HITCH_SERVER_URL`), V1
  byte-untouched and still the default. Auth in main process (api-key in renderer, no cookies),
  main-held native WS → IPC → TanStack invalidation. Full task surface: read path + Inbox,
  capture/edit dialog (editor unchanged, echo suppression), mutations (deferred-DELETE undo),
  tags (names-as-client-identity → V1 components imported unchanged), attachments (renderer-direct
  presigned PUTs; relative refs in bodies), ⌘K palette + connection banner. Six V2 e2e suites
  green; V1 e2e baseline identical to main throughout. REMAINING: Will dogfoods V2 against
  Railway (needs M1 step 8).
- [x] **M3 — CLI** (DONE 2026-07-22, PR #101): cli/ workspace, self-teaching help/errors,
  --json everywhere, unique-prefix ids, verbatim bodies. Acceptance: cold `claude -p` runs drove
  it end-to-end with zero stumbles, no skill file. No `attention` command yet (assignments empty
  until M4). No CLI sign-up (accounts come from the desktop; login error says so).
- [x] **M4 — Daemon reconciler** (DONE 2026-07-22, PRs #102–#108; plan + per-PR detail in
  docs/v2-m4-plan.md): the daemon is a pure reconciler in V2 mode (`HITCH_SERVER_URL`), V1
  byte-untouched and still the default. Machine register + 30s heartbeat, chat-state relay
  (shared sqlite store, independent server_synced_at cursor so V1+V2 don't starve each other),
  desired/observed reconcile loop (spawn-on-assign via cmux launchers, close-on-stop, transition-
  only observations), WS focus relay, and reconnect resilience (re-hello + re-register + reconcile
  + resync). D5 assign UX shipped as the delegate bar (option L). Fake-launch mode
  (`HITCH_FAKE_LAUNCH=1`) drives the whole loop with no cmux/agent. File sync + Convex push
  REMAIN (they die at M5, not M4 — see the plan's confirmed reading). Acceptance: the fake-loop
  check (13/13, pending→spawning→running→waiting_input→done + chat busy→waiting_input→dead) and
  Will's real-cmux reconciler pass. REMAINING: Will dogfoods real delegation ahead of M5.
- [ ] **M5 — Cutover + delete:** real import, one week of real V2 use, then delete convex/ + task
  files + sync machinery. (Prod export already banked — see Environment status.)

## Still-open (deferred, not blockers)

- D5 assign-time UX — DECIDED at M4: the delegate bar (option L — compose/active/re-delegate,
  agent + machine pickers, preset + editable prompt, ⌘⏎). Shipped in PR #106.
- D6 chat-monitoring hardening (ground-truth backstop under hooks) — carved-out separate workstream.
- projects.repo_path multi-machine normalization — when a 2nd machine appears.

## Progress log

- 2026-07-21 — PRD created; architecture decided. D2 (in-place), D3 (import = TASKS ONLY: title,
  body verbatim, tags, sections, order, open/done), D4 (downtime OK; export prod first) closed.
- 2026-07-22 — Automations AXED. No-command-bus model settled (state=rows, events=WS relay).
  `runs` renamed `assignments`. D1/schema closed → **M0 complete**.
- 2026-07-22 — Convex prod export banked + verified + gitignored. Docker confirmed running.
  Ready to start M1 step 1 on branch `feat/v2-server`. (Conversation compacted after this point.)
- 2026-07-22 — M1.1 merged (PR #86): server/ + shared/ scaffold, chained-route AppType.
- 2026-07-22 — M1.2 merged (PR #87): schema v1 exact-per-spec + NOTIFY/updated_at triggers.
  Amendment in review: deliberate ON DELETE (task children CASCADE; section→tasks SET NULL;
  machines NO ACTION). task_tags NOTIFY payload is {table, task_id, tag_id} — step 5 handles it.
- 2026-07-22 — M1.3 merged (PR #88): CRUD + zod + hc<AppType> client in shared/. Ownership split
  enforced (client PATCH: desired_state/reviewed_at; daemon PATCH: observed_state/chat_id/worktree).
  **Design ripple accepted:** tasks REQUIRE a project (no user_id on tasks) → "Inbox" becomes a
  real per-user project, Todoist-style. M2 capture UX + M1.7 importer must create/use it.
- 2026-07-22 — M1.4 merged (PR #89): better-auth 1.6.24 (+@better-auth/api-key — split out of core
  in 1.6.x). Keys-as-sessions so requireAuth = one getSession path; per-key rate limit disabled
  (default 10 req/day would starve the daemon tick). Migration 0002 = auth tables + real user_id FKs.
- 2026-07-22 — M1.5 merged (PR #90): /ws (upgrade auth = requireAuth verbatim), LISTEN client with
  capped backoff, invalidate broadcast to ALL authed conns (documented v1 simplification), ephemeral
  event relay with hello/machine registration. Wire types exported from shared/.
- 2026-07-22 — M1.6 merged (PR #91): node:24-slim Dockerfile (MIGRATE_ON_BOOT), compose = self-host
  story (Garage init via curl sidecar — image has no shell). Attachments presigned flow; gotchas
  banked: AWS SDK ≥3.729 CRC32 default breaks S3-compat presigned PUTs (WHEN_REQUIRED fix, also
  matters on Buckets/R2); S3_PUBLIC_ENDPOINT for split-horizon presigning.
- 2026-07-22 — M1.7 merged (PR #92): importer. V1 facts learned: no sections exist in V1;
  backlogOrders empty in prod → order = updatedAt/completed-at desc; export is PRE-todos-v1 for
  status (legacy status: values) and STALE for the Hitch project (41 vs 98 live tasks).
  **M5 must import Hitch project via --from-dir and everything else via the export zip.**
  Dry-runs verified: dir = 98 tasks/4 tags/54 links; export (Will) = 7 projects/93 tasks/12 archived
  skipped. Bodies byte-for-byte in both paths. M1 steps 1–7 COMPLETE — step 8 (Railway) blocks on Will.
- 2026-07-22 — **M4 started** (plan: docs/v2-m4-plan.md). PRs #102–#105 landed the daemon
  reconciler: #102 V2 foundation (config/serverClient/daemonV2 register+heartbeat, Node-`ws`
  client with capped backoff + re-hello), #103 chat-state relay (observer → shared sqlite →
  `POST/PATCH /daemon/chats`, independent `server_synced_at` cursor so V1 Convex + V2 Hono sinks
  don't starve each other), #104 reconciler core (pure desired-vs-truth diff; spawn = claim →
  chat row → `spawning` → cmux launch → transition-only observations; close-on-stop → `done`;
  in-flight guard), #105 fake-launch (`HITCH_FAKE_LAUNCH=1`, cmux-less scripted lifecycle,
  heal-proof by construction).
- 2026-07-22 — M4 #106 delegate bar (D5, option L): compose/active/re-delegate, agent + machine
  pickers (machine hidden-when-one, disabled-when-stale), preset + editable prompt, ⌘⏎; POST
  /assignments; preamble stamps title + verbatim body + id + `hitch` CLI line. #107 attention
  queue + focus relay + close-on-done: NEEDS-YOU/WORKING groups joined by task_id, main-held
  ws-send IPC → focus event → daemon `openChat` + activateApp; done-check PATCHes
  desired=stopped. **Acceptances:** fake-loop (13/13 on the compose stack, zero real spawns) and
  Will's real-cmux reconciler pass (`v2-reconciler-real-machine.mjs`).
- 2026-07-22 — **M4 DONE** #108 hardening + docs (`feat/v2-m4-07-hardening`). Two carried-over
  review items + resilience:
  - **Legacy-chat 400-storm (real-machine finding).** ~720 legacy V1 chats carry a Convex-id
    `project_id` (e.g. `m17brnqs30pyevfc05dp3r3x4s87z3an`), which `chatCreate`'s `z.uuid()`
    rejects → a 400 per row every 2s sync round, forever (a failed push never cleared the
    server cursor). Fix: relay only chats it can represent — an `isRepresentable` guard skips a
    non-UUID-projectId row before the wire, and any non-retryable 4xx (400/409/422) marks-synced-
    and-skips permanently. Pinned by `smoke:v2-chat-legacy-skip` (zero repeated 400s across two
    rounds + a restart).
  - **In-session sign-in now starts the daemon** via the existing seam (`onSignIn`→`restartDaemon`,
    idempotent; `onSignOut`→`stopDaemon`), instead of only on next boot.
  - **Reconnect trio**: on every WS re-connect the daemon re-registers (idempotent upsert) +
    reconciles + resyncs chats (on top of re-hello) — verified with a mid-run `docker compose
    restart server`. **Stale-machine surfacing**: the delegate bar now says WHY ("last checked
    in 4m ago").
  - **Real-machine gotcha (banked):** on a COLD machine the harness's first-run "trust this
    folder?" prompt can appear when the reconciler spawns into a repoPath the agent hasn't seen,
    stalling the spawn on human input — the fake-launch path never exercises it. Flagged, not
    auto-handled (revisit if it bites during Will's M5 dogfood).
