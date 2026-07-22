# Hitch V2 — M2 plan (Desktop on server)

> Decomposition produced 2026-07-22 by the planning pass; execution doc for M2 subagents.
> Parent doc: docs/v2-prd.md (architecture + schema are CLOSED there — do not relitigate).
> Core seam decision: **parallel V2 data layer + V2 shell behind a runtime mode switch**, reusing
> the presentational layer (components/ui, tags, the entire editor/). V1 files are NOT edited;
> main stays Will's daily driver. V2 mounts when the main process sees `HITCH_SERVER_URL`.

## Evidence summary (from code investigation)

- Convex enters the renderer directly: ~55 `useQuery/useMutation(api.*)` call sites across ~15
  files (App.tsx 15, TodoDialog 7, TodosView 5, AppSidebar 5, SnippetsPanel 5, ProjectDetailsDialog
  5, DeviceTokens 4, + hooks useChats/useAttachments/useAutomations/useSkills/useSnippets/
  useTaskPersistence/useOpenChat). The deep coupling is the data model (tasks = Convex `files`
  rows, markdown + frontmatter; `lib/todos.ts` deriveTodoGroups reads frontmatter). A FileRow
  adapter would synthesize/parse frontmatter → violates body-VERBATIM. Hence parallel shell.
- Editor needs ZERO changes: MarkdownEditor is a controlled body-markdown component
  ("Frontmatter never enters the formatted editor", useFrontmatterDocument.ts:121). Only the
  document hook above it changes: `useTaskDocument` over {title, body} row fields — per-field
  dirty tracking, adopt external values when clean, keep local when dirty. Save = save-on-close +
  explicit checkpoints + ~1.5s idle debounce autosave. Single user → last-write-wins, no version column.
- Auth: main-process flow, api-key in renderer, NO cookies. Renderer form → IPC → main POSTs
  /api/auth/sign-in/email (Node fetch, no Origin/CORS), captures session cookie, mints api key via
  /api/auth/api-key/create, stores {serverUrl, apiKey} in secrets.json, discards cookie. All
  renderer HTTP = hc client with x-api-key. V1's 51789 OAuth loopback untouched (not started in V2
  mode). trustedOrigins TODO dissolves (no renderer origin ever hits /api/auth/*).
- WS: held in the MAIN process (browser WebSocket can't set headers; Node ws client sends
  x-api-key; survives renderer reloads). Main forwards invalidate/event messages over a preload
  channel; renderer maps {table,id} → coarse per-table TanStack keys (["tasks"], ["projects"], …);
  task_tags' composite payload {table, task_id, tag_id} → ["tasks"] (lists embed tagIds).
  On ws open/reconnect → invalidateQueries() with no key (refetch everything, per PRD).
- Sections: NO sections UI in M2 (V1 has none, importer creates none; server routes sit unused).
- Machines/assignments/attention/delegation UI: M4, excluded. Query-key map + WS forwarding
  already carry those tables (free). V2 TodosView keeps the four-group scaffolding; NEEDS YOU /
  WORKING empty-and-hidden until M4.
- Not built in V2 shell (M4 or dies at M5): AutomationsView (dead at M5), LocalSyncDialog +
  file-sync controls (M5), DeviceTokens (M5), chat actions/DelegationBand/HarnessChip/useChats/
  useOpenChat (M4/D5), SnippetsPanel (M4/D5), skills slash-menu data (M4), Convex command bus
  (no V2 successor), Archive tab (V2 has no archived state — D3 skips archived; "done" suffices).
  The convex npm dep + ConvexClientProvider stay until M5.

## Decisions adopted (orchestrator, 2026-07-22 — flag to Will, don't block)

1. Runtime mode switch on main (env `HITCH_SERVER_URL`) — NOT a long-lived branch (rebase cost vs
   daily V1 use; every PR merged and testable).
2. LLM auto-title DROPPED in V2 (command bus has no successor); seed-title from body remains.
   Revisit as a daemon feature post-M4 if missed.
3. Snippets deferred to M4/D5 (they're delegation prompt templates; no table yet, on purpose).

## Step 0 — server-side gaps (one small server PR, blocks PR 1–2)

1. CORS middleware on the Hono app: origin "*", allowHeaders content-type + x-api-key (legal with
   "*" — auth is a header, not credentials).
2. `GET /tasks` + `GET /tasks/:id` must return `tagIds: string[]` (today: bare rows, no way to
   list task_tags links) — keeps the task_tags→["tasks"] invalidation mapping coherent.
3. Replace the trustedOrigins TODO in server/src/auth.ts with the main-process-auth explanation.
4. Bucket CORS for renderer presigned PUTs: verify against composed stack once; fallback decided
   in PR 6 (upload via main-process IPC).

## Desktop PRs (ordered; 2→3→4 sequential; 5 and 6 parallel after 3)

- **PR 1 — V2 foundation**: main-process hitchServer module (config, signIn/signUp/signOut IPC →
  cookie → mint api key → secrets.json; main-held WS with backoff + IPC forward), preload
  window.hitchServer, renderer lib/server/ (hc client factory + QueryClientProvider + key map +
  invalidation subscriber + reconnect-invalidate-all), main.tsx mode switch, skeleton AppV2
  (sign-in form → project list proof-of-life). Verify: key-map unit tests; boot against compose;
  V1 regression (launch without env var; existing e2e passes). Risk check: confirm api-key auth
  doesn't write session rows per request.
- **PR 2 — TodosViewV2 read path + Inbox**: sidebar w/ server projects, Inbox ensure-by-name,
  open-by-sort_order + done-by-completed_at groups via slim lib/v2/todoGroups.ts, read-only tag
  pills from tagIds. Verify: e2e render check + grouping unit test.
- **PR 3 — TaskDialogV2**: capture (⌘⏎ POST, deriveTitleFromBody seed, fractional-index prepend,
  captureDraft recovery) + edit (useTaskDocument, MarkdownEditor unchanged, save-on-close +
  debounce autosave, LWW). Port the TodoDialogState discriminated-union pattern, not the file
  model. Echo suppression: refetch must not reset Lexical mid-type (keep body byte-identical when
  dirty). Verify: adapted editor + capture-draft e2e; unit tests for merge/dirty logic.
- **PR 4 — list mutations**: check/uncheck (uncheck → top of backlog), drag reorder = single-task
  sort_order PATCH, delete + undo toast, keyboard nav + context menu. Optimistic onMutate with
  in-flight query cancellation (TkDodo pattern). Verify: adapted keyboard-delete/context-menu/
  undo-toast e2e.
- **PR 5 — tags on server**: TagCombobox/TagFilterBar → /tags + /tasks/:id/tags/:tagId; create
  with color; localStorage filter state reused; facet counts from tagIds. Verify: e2e + unit.
- **PR 6 — attachments (highest risk)**: create pending → presigned PUT → finalize; paste/drop in
  dialog; previewHandler (ImageNode seam) resolves relative `attachments/<name>` refs → presigned
  GET, cached with expiry. Bodies keep RELATIVE refs — never presigned URLs (they expire; PRD:
  keys not URLs). CORS-preflight fallback: upload via main-process IPC. Verify: adapted
  image/file-attach e2e.
- **PR 7 — polish + cutover-readiness**: minimal CommandPalette V2, sign-out, server-unreachable
  banner, empty states, AGENTS.md note (e2e can drive V2 via HITCH_SERVER_URL), PRD log update.
  Then Will dogfoods V2 against Railway (needs M1 step 8).

## Critical files

- desktop/src/renderer/main.tsx (mode-switch seam)
- desktop/src/main/main.ts (auth IPC ~1242–1261, loopback ~2749–2791 — patterns to mirror)
- desktop/src/renderer/components/todo-dialog/TodoDialog.tsx (state machine + save policy to port)
- shared/src/index.ts (typed hc client + WS wire types)
- server/src/routes/tasks.ts (step-0 tagIds gap)

## Progress

- [x] Step 0 (server gaps)
- [x] PR 1 foundation · [x] PR 2 read path · [x] PR 3 dialog · [x] PR 4 mutations ·
  [x] PR 5 tags · [x] PR 6 attachments · [x] PR 7 polish
