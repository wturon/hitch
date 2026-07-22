# Hitch V2 — M4 plan (Daemon reconciler + D5 assign UX)

> Decomposition produced 2026-07-22; execution doc for M4 subagents.
> Parent: docs/v2-prd.md (CLOSED architecture/schema). Pattern parent: docs/v2-m2-plan.md
> (dual-mode, V1 byte-untouched, runtime mode switch — the daemon gets the same treatment).
> Confirmed reading: the PRD's "remove file sync + Convex push" lands at M5, NOT M4. V2 mode
> (`HITCH_SERVER_URL` present) runs `startHitchDaemonV2` and simply never starts file-sync/Convex;
> default mode stays V1.

## Evidence summary

- daemon.ts (2131 LOC) boots file sync + command bus + frontmatter projection + skills sync +
  observer as one unit, hard-requiring Convex URL + HITCH_DEVICE_TOKEN. V2 reuses AS-IS:
  ChatStateObserver + chatLifecycleStore + reducer + hook pipeline, launchers/ + cmux.ts,
  DaemonLifecycleProducer. V2-mode never starts: file push/pull, frontmatter projection, command
  bus, chat-request flags, Convex chat sync, skills sync, title generation.
- Observer needs only `{projectId, localPath}[]` to map cwd→project — V2 feeds it from server
  projects.repo_path. Statuses derived today: working | needs-input | waiting | idle (+endedAt).
- cmux.ts: startChat (claude --session-id pinned up front), openChat (focus-else-resume-spawn +
  activateApp), closeChat (workspace-scoped), beforeCommand surface stamping (Codex id-gap claim).
  All reusable verbatim. Launcher default env for codex is codex-app — V2 must pass "cmux".
- Worktrees: V1 never uses them. assignments.worktree stays null in M4.
- Server contract is fixed and SUFFICIENT — no step-0 server PR. (Optional nicety: machine_id
  filter on GET /assignments; daemon filters client-side at this scale.)
- V1 delegation flow: useDelegationComposer (last-agent localStorage seed, BUILTIN_STARTING_PROMPTS
  + custom prompts via preferences.json bridge, phase latch, global ⌘⏎). V1's Convex tail is
  replaced by one POST /assignments. TaskDialogV2.tsx:48 reserves the delegate-bar seam.
- Desktop: hitchServer.ts has server→renderer WS forwarding only — PR 6 adds a ws-send IPC for
  focus. main.ts startDaemon goes idle with no hitches configured — V2 mode bypasses that guard.
- No V2 fake-host machinery exists — PR 4 builds HITCH_FAKE_LAUNCH.

## State mapping (exact)

Chat store → chats.status: working→busy; needs-input→waiting_input; waiting→waiting_input;
idle w/o endedAt→idle; endedAt set→dead.

assignments.observed_state (daemon-only, transition-writes only):
- pending: row exists, daemon hasn't acted (default)
- spawning: daemon claimed spawn — PATCH {chatId, "spawning"} after POST /daemon/chats, before launch
- running: linked chat busy
- waiting_input: linked chat waiting_input (turn complete or blocked — the "agent finished a pass" signal)
- done: linked chat dead/idle-after-ended having spawned; also the result of executed desired=stopped
- dead: launch failure or chat never bound

## Decisions adopted (orchestrator 2026-07-22 — flagged to Will, not blocking)

1. No prompt_templates table: reuse BUILTIN_STARTING_PROMPTS + local custom-prompts bridge;
   composed prompt stamped VERBATIM into assignments.prompt.
2. Prompt preamble embeds task title + body verbatim + task id, + one-line note that the `hitch`
   CLI can read/comment/complete it if installed. No hard CLI dependency. (Wording → Will can tweak.)
3. Close-on-done is CLIENT intent (V1 PR #68 equivalent): checking done also PATCHes
   desired_state=stopped on live assignments; reconciler closes the tab. Daemon stays rule-free.
4. Spawn cwd = project.repoPath ?? homedir(); "no repo linked" hint in bar. repoPath editing UI
   only if trivially cheap; else CLI/curl for M4 (flagged).
5. V2 spawns force (harness, "cmux") for both harnesses.
6. Keep wide discovery (ad-hoc chats flow to server for free). D6 hardening NOT touched.
7. ONE deliberate V1-file edit: additive server_synced_at column + listServerDirtyChats/
   markChatServerSynced in chatLifecycleStore.ts, so concurrent V1+V2 daemons don't starve each
   other's sync flags. Existing methods untouched.

## PR steps (1→2→3→4 sequential; 5 parallel after 1; 6 after 3+5; 7 last)

- **PR 1 — daemon V2 foundation**: v2/config.ts (env HITCH_SERVER_URL+HITCH_API_KEY, fallback
  secrets.json hitchServer), v2/serverClient.ts (hc + x-api-key), v2/daemonV2.ts (register machine
  by hostname+version → machineId; 30s tick heartbeat), v2/ws.ts (Node ws, hello{machineId},
  capped backoff, handler dispatch). Seams: index.ts/runner.ts branch on env; daemon gets
  @hitch/shared dep. Verify: machine row + advancing last_seen_at against compose; focus event
  relayed and logged; V1 boot regression.
- **PR 2 — chat-state relay**: v2/projects.ts (repoPath map, refresh on invalidate), observer +
  reduce loop wired, v2/chatSync.ts (mapping above; POST/PATCH /daemon/chats; server id per
  localKey), store server_synced_at (Decision 7). Verify: smoke mapping test; real cmux chat
  appears/tracks live.
- **PR 3 — reconciler core**: v2/reconciler.ts — triggers: 30s tick, assignments invalidate, WS
  reconnect. Diff desired vs ground truth: spawn path (task+repoPath fetch → prompt build →
  claude pinned-uuid / codex beforeCommand claim → chat row → spawning → launch; error→dead);
  stop path (closeChat → done); observation derivation (transition-only PATCHes). In-flight spawn
  guard. Verify: real-machine script — assignment via CLI/curl spawns a real cmux tab;
  desired=stopped closes it; transitions land.
- **PR 4 — fake-launch mode**: HITCH_FAKE_LAUNCH=1 → v2/fakeLauncher.ts (Launcher-shaped, no
  cmux; scripted lifecycle events via DaemonLifecycleProducer; no transcript so Claude heal can't
  touch it). Isolated store path env. dev script for compose+V2 daemon; AGENTS.md note. Verify:
  headless loop pending→spawning→running→waiting_input, zero real spawns.
- **PR 5 — D5 delegate bar** (option L): v2/DelegateBar.tsx — compose (agent picker seeded
  last-agent, machine picker hidden-when-one/disabled-when-stale, preset dropdown + editable
  prompt collapsed, ⌘⏎ default delegate) / active (Spawning…/Working/Needs you/Done chip + Open
  chat + Stop) / re-delegate (history preserved). useDelegationComposerV2 (V1 hook untouched),
  useAssignments(taskId), POST /assignments. Verify: composer unit tests; check-v2-delegate.mjs
  vs fake daemon. Monochrome; amber only via existing NEEDS YOU treatment.
- **PR 6 — attention queue + focus relay + close-on-done**: todoGroups/TodosViewV2 fill NEEDS YOU
  (waiting_input ∪ done∧unreviewed) and WORKING (spawning|running) joined by task_id; ack →
  PATCH reviewedAt. hitch-server:ws-send IPC; Open chat → focus event → daemon openChat +
  activateApp. Done-check stops live assignments (Decision 3). main.ts V2-mode daemon spawn env +
  idle-guard bypass (byte-identical V1 path). Verify: full-loop e2e = the M4 acceptance
  (delegate → fake spawn → NEEDS YOU → ack clears; focus logged); Will does one real-cmux pass.
- **PR 7 — hardening + docs**: reconnect/re-register idempotency, stale-machine surfacing, PRD
  log, AGENTS.md. Then Will dogfoods real delegation ahead of M5.

## Critical files

- daemon/src/daemon.ts (V1 boot to mirror-and-bypass; mode-switch seam context)
- daemon/src/cmux.ts (spawn/focus/close executors)
- daemon/src/chatLifecycleStore.ts (the one additive V1 edit)
- server/src/routes/daemon.ts (fixed contract)
- desktop/src/renderer/v2/TaskDialogV2.tsx (delegate-bar seam, line ~48)

## Progress

- [ ] PR 1 foundation · [ ] PR 2 chat relay · [ ] PR 3 reconciler · [ ] PR 4 fake launch ·
  [ ] PR 5 delegate bar · [ ] PR 6 attention+focus · [ ] PR 7 hardening
