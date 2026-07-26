# Chat tracking redesign (V3)

**Status:** written 2026-07-25, **fully built** the same week. §7's snapshot
endpoint + the server-side status function, the daemon-side rework (spool dir,
`cursors.json`, snapshot PUT, deletion of the local chat model), §4's attachment
layer and §9's Chat Inspector all shipped. §10 "What actually landed" records
what each phase really did — including the two phases that were overtaken and
the places the implementation contradicted this document. Nothing here is
unbuilt; §11's open questions are still open.
**Supersedes:** the status-ownership model in `docs/chat-lifecycle-contract.md`.

Companion artifacts (same content, prettier):

- Research + architecture — https://claude.ai/code/artifact/0df3e670-ff5e-47a5-8ba8-fb2fa9714961
- Clean-sheet design (rev 3) — https://claude.ai/code/artifact/3e645873-23f0-4bf3-a307-1e355fdba919
- Chat Inspector debug UI (rev 2) — https://claude.ai/code/artifact/a9ee4745-0d35-435c-8bfe-3695c9f17bdb

---

## 1. The problem, measured

Two different things are called "chat status":

- **Server** — `chats` row in Postgres (`server/src/db/schema.ts:173-194`): 10 columns, status enum
  `busy | waiting_input | idle | dead`. This is what the product renders.
- **Machine** — `chat-lifecycle.sqlite` in the app-support dir: 4 tables, a full parallel chat model,
  plus every piece of evidence behind the status. Almost none of it is reported up.

Measured on `~/Library/Application Support/Hitch Dev/chat-lifecycle.sqlite` on 2026-07-25:

| Metric | Value |
| --- | --- |
| `local_chats` rows | 748 (36 columns each) |
| …ever synced to the server | **2** |
| …carrying a legacy non-UUID `project_id` (permanently skipped by the sink) | 747 |
| `chat_events` rows | 15,726 (oldest 2026-07-15 — 10 days) |
| File size | 10.8 MB dev / 4.3 MB prod, growing ~1 MB/day |
| Non-ended chats | 246 |
| …where hook status disagrees with the observer | **170** |
| …`waiting` (events) vs `idle`/`dormant` (observed) — stale, turn never closed | 162 |
| …`working` (events) vs gone (observed) — **product shows a busy agent that died** | 8 |

Two root causes:

1. **Existence is derived from events.** A chat is only marked dead when a `session.ended` event arrives.
   Claude's `SessionEnd` does not fire on `/exit` (Open Island documents this explicitly), so rows wedge forever.
2. **Discovery is unbounded.** Every competing product caps its working set; we don't. That is what produced
   748 rows, not discovery itself.

Contributing facts:

- `preferObserver` is hardcoded `false` at `daemon/src/chatLifecycleStore.ts:1049`, `:1096`, `:1318`.
  The entire level-triggered observer (~1,388 lines in `daemon/src/observer/`) runs dark — shadow columns only.
- `pruneReducedEvents()` and `pruneCmuxTrace()` (`daemon/src/chatLifecycleStore.ts:647`, `:732`) have
  **zero callers**. Their only caller was V1's `daemon/src/daemon.ts`, deleted at the V2 cutover.
  Retention constants (`7d` events, `3d` trace, 5,000-row trace cap) are dead code.
- `chats.cmux_ref` is `notNull()` (`server/src/db/schema.ts:184`) — a chat **cannot exist** in our database
  without a cmux reference, which structurally forbids detecting a bare-terminal chat.
- There is no client-facing `GET /chats`. The only read is `GET /daemon/chats?machine_id=`
  (`server/src/routes/daemon.ts:69`).

---

## 2. Research: how five other products do it

Full reports were generated 2026-07-25 from cloned repos + vendor docs. Condensed:

| | AgentGlance | Agent Island | Open / Vibe Island | AgentPeek | Hitch today |
| --- | --- | --- | --- | --- | --- |
| Primary sensor | Hooks → spool dir | **None** — transcripts only | Hooks → Unix socket | Hooks + plugins | Hooks → SQLite |
| Liveness | libproc + `EVFILT_PROC` | Time decay only | `ps` + `lsof` poll | Process scan + CPU/IO | Built, switched off |
| Death detected by | Process gone ×2 misses | 30 min silence | Process gone ×2 misses | Process scan | A `SessionEnd` event |
| Needs-input from | `Notification` hook | **Not modeled** | `PermissionRequest` hook | Hook events | `Notification` hook |
| Status computed | Level, each tick | Level, each tick | Level, each poll | Unpublished | Edge, accumulated |
| Persisted state | One doc per live process | None | 24 h mirror, flags dropped | Local only | Unbounded, no prune |
| Discovery bound | Live process only | 120 files (Codex) | 24 h mtime, 40 files | — | 200 threads (Codex only) |
| Multi-machine | No | No | SSH relay (Vibe only) | No | Server of record |

**The law everyone obeys: events own semantics, ground truth owns existence.**

Supporting detail worth keeping:

- **Agent Island** is the outlier that proves the rule — it refuses hooks entirely and therefore has
  *no needs-input state at all*, because a permission prompt and a slow tool call are indistinguishable on disk.
- **AgentGlance** keys process identity as `(pid, kernel_start_time_us)` and threads it through liveness, dedup
  and exit watchers — kills PID reuse. Its state doc lives exactly as long as its process. Its app-owned
  "enrichment overlay" never overwrites the producer-owned lifecycle document (single writer per field).
  Its process-scan fallback publishes `idle` on the stated principle that *idle beats guessing working*.
- **Both commercial products ship hook self-healing** — CLI updates and rival tools overwrite `settings.json`.
  It is their #1 shared failure mode. **Correction (2026-07-25):** this row originally read "we install
  once and never verify", which was wrong when written and is wronger now. `healDriftedHarnessHooks()`
  (`desktop/src/main/main.ts:1354`, called at boot before the daemon starts) re-verifies both harnesses on
  every launch and reinstalls anything *drifted* — it deliberately does **not** install for someone who
  never opted in. Codex already detected drift by comparing the on-disk script against the template
  byte-for-byte; #115 gave Claude the same `scriptCurrent` content check, which was the real gap, since
  until then a stale Claude hook script from an older build read as installed and was trusted forever.
- **Blocking hooks are a real hazard.** Vibe Island's `Stop` hook blocks Claude shutdown 15–21 s;
  Open Island holds hook connections open up to 24 h to render approval buttons. Our fire-and-forget
  write-and-exit is strictly better — do not trade it for interactivity.
- Both commercial products have a documented, recurring bug class of sessions **stuck in the wrong state**.

---

## 3. The model: three axes, one owner each

Status stops being one value with two competing writers. It becomes three independent facts:

| Axis | Values | Owner | Forbidden |
| --- | --- | --- | --- |
| **Existence** | `running` / `dormant` / `pending` | The machine — process table, keyed `(pid, start-time)` | Events may **never** write this |
| **Activity** | `working` / `idle` / `unknown` | The machine — pidfile self-report, transcript mtime delta | `unknown` resolves to **idle**, never working |
| **Block** | `permission` / `question` / none | Hook events — the only source that can see it | Never outlives the process that raised it |

`status = f(existence, activity, block, at)` — a pure function, **on the server**.

`daemon/src/observer/types.ts` already names these axes and already documents why needs-input is event-only.
The model isn't new; it was built and then left disconnected from the thing that renders status.

---

## 4. Three layers, cleanly separated

Observation must be decoupled from environment, focus and close.

1. **Observation** (daemon, harness-aware)
   - Identity: `(harness, sessionId, host)`.
   - Knows: Claude/Codex file formats, the process table, transcript cursors.
   - Blind to: cmux, terminals, tabs, editors, tasks, focus, close.
   - **Enforceable rule:** the observation layer must compile and pass its tests with **zero imports from
     `daemon/src/launchers/` or anything cmux**. Make it a lint rule.
2. **Attachment** (optional, nullable) — two independent things:
   - `task` — which assignment this chat serves (product truth).
   - `handle` — how to focus or close it (convenience).
   - A chat with neither is a complete, correct chat.
3. **Server** — the status function, chat history, everything the product renders.

Consequence: `chats.cmux_ref` becomes a nullable `handle`. `codexCmuxLaunchClaims` and `cmux_trace` move out
of the lifecycle store — they are launch/focus machinery that ended up inside observation.

**Accepted asymmetry:** a chat discovered in a bare terminal is fully observable and *not focusable*, because
we have no handle for it. That is a product statement, not a bug — *we see everything, we can return you to
what we launched.* Focus/close/terminal-binding are explicitly deferred.

---

## 5. The design, in six rules

1. **One pipeline, two entry points.** Discovery finds chats; the launcher pre-registers ones we start.
   Both land in the same tracked set and are observed identically. Launch data *enriches* a chat; it never
   creates a second kind of chat.
2. **Observation is environment-blind.** See §4.
3. **The working set is bounded; the archive is not.** The daemon only looks at live processes plus
   transcripts touched inside a recency window (24 h, capped). Aging out is **not** deletion — the chat keeps
   living on the server with its final status, and resuming pulls it back into the window.
4. **The daemon PUTs a snapshot, not deltas.** The whole working set every tick, each chat carrying its own
   existence. **A chat missing from the snapshot is no longer live** — that is the entire heal path. No
   `session.ended` dependency, no dead-miss bookkeeping on the server, no wedged rows possible by construction.
5. **Hooks are a nudge, never a ledger.** Two jobs: report `block`, and wake the loop early so the UI doesn't
   wait a tick. Ours are installed user-level so they fire for discovered chats too. **Test: if every hook were
   lost, status should still be correct — just later.**
6. **Status is one pure function, on the server.** The daemon reports; it never decides.

---

## 6. Local state: two files, no database

The local store cannot be deleted outright — hooks are independent short-lived processes that fire when the
daemon is dead, the machine is offline, or the server is down, and must never block the harness. (The Islands
pipe hooks over a Unix socket to the app, losing every event the app isn't running for. Ours survives that.)

But the inbox only needs **append** and **drain**, and SQLite is a heavy way to buy them.

| | Today, per hook fire | After |
| --- | --- | --- |
| Hook does | import `node:sqlite`, mkdir, open DB, 3 PRAGMAs, `BEGIN IMMEDIATE`, `CREATE TABLE IF NOT EXISTS` ×2 + 3 indexes, commit, insert, write bump file, close | write one small JSON file into a spool dir, exit |
| Schema lives | twice — hook template in `desktop/src/main/main.ts` **and** `chatLifecycleStore.ts` | nowhere; there is no schema |
| Daemon wakes via | a separate `chat-lifecycle.bump` file | `fs.watch` on the spool dir — the write *is* the signal |
| Failure modes | locks, busy timeouts, migrations, corruption, duplicated DDL drift | a malformed file is skipped and deleted |

```
~/Library/Application Support/Hitch/
  events/                     # spool — hooks append, daemon drains and deletes
    1753426442-8f3a.json
    1753426451-c1d0.json
  cursors.json                # daemon-owned: offset, dev/ino, size, mtime per transcript. Disposable.
```

**Disposability test:** delete either at any moment and you lose in-flight events at worst. Add it to CI —
wipe the files, run one tick, assert the world re-derives. (Today you'd lose 748 chats.)

---

## 7. Wire protocol

One endpoint carries all chat state.

```
PUT /daemon/machines/:id/chat-snapshot   # every tick, ~1s active / 30s idle, skipped when unchanged

{
  "observedAt": "2026-07-25T09:14:02Z",
  "window":    { "since": "2026-07-24T09:14:02Z", "cap": 60, "truncated": false },
  "chats": [
    {
      "harness":   "claude",
      "sessionId": "0f2c…a91b",        # filename for Claude, session_meta.id for Codex
      "cwd":       "/Users/w/code/hitch",
      "process":   { "pid": 48213, "startedAt": 1753… },   # identity, not just pid
      "existence": "running",          # running | dormant | pending
      "activity":  "working",          # working | idle | unknown
      "source":    "claude-pidfile",   # what produced it — kept as evidence
      "evidence":  { "self": "busy", "mtimeAge": 1.2 },

      "task":      "a3e0…",            # attachment 1 — assignment, null for found chats
      "handle":    { "cmux": "surface:7" }   # attachment 2 — focus only, always nullable
    }
  ],
  "events": [                          # drained spool, relayed verbatim
    { "sessionId": "0f2c…a91b", "kind": "block.permission", "at": "…" }
  ]
}
```

`truncated` tells the server coverage was incomplete rather than letting it believe it saw everything.

### Snapshot membership

| Chat | In snapshot? | Existence | Server effect |
| --- | --- | --- | --- |
| Live process bound to a session | yes | `running` | Status from activity + block |
| Transcript touched inside window, no process | yes | `dormant` | Idle, resumable, still visible |
| Launched by Hitch, session id known (claude) | yes | `pending` | Spawning; timeout marks it failed |
| Launched by Hitch, session id NOT known (codex) | **no** | — | Assignment reads `spawning`, no chat row |
| Was live last tick, now gone | **no** | — | Marked dead after two consecutive misses |
| Nothing for 24 h | **no** | — | Keeps last status; stays in history |

The two-miss debounce lives in the daemon, so a transient read failure never removes a live chat.
Everything downstream of the snapshot needs no heal logic at all.

**Correction (phase 4).** Row 3 originally read "Launched by Hitch, not yet bound → `pending`" with no
harness split, and that isn't buildable: `pending` needs a session id to key the row on, and Codex has none
until its first prompt produces a thread. Only Claude (`--session-id`) can be pre-registered. The Codex gap
is carried by the durable launch record instead of a chat row — see §10, phase 4, "Spawn".

### What the tick reads

- **Discovery, cheap first:** Claude pidfiles + `claude agents --json`; Codex's own thread catalog
  (`~/.codex/state_5.sqlite`, opened read-only). These enumerate *live* sessions directly — no transcript
  archaeology needed to find them.
- **Existence:** `kill(pid, 0)` + start-time compare. Dormant = transcript inside window, no live process.
- **Activity:** Claude pidfile self-report where available; else transcript `(mtime, size)` delta against the
  cursor cache with a settle timer.
- **Block:** spooled hook events only.

**Deliberately absent: routine transcript parsing.** Tail-reading buys turn-boundary precision the `Stop` hook
already gives us instantly. Keep it as the fallback for a harness with no usable hook. (Agent Island tails
every Claude transcript on every tick with no cap — the most expensive thing it does.)

---

## 8. Keep / cut / add

### Keep

- **Wide discovery.** Core to the product — users must not be required to launch through Hitch. Bound it,
  don't delete it.
- **The observer's sensing code** (`daemon/src/observer/claudeObserver.ts`, `codexObserver.ts`, `liveness.ts`,
  `tail.ts`). Matches or beats the field. Cadence is already right: 1 s active / 30 s idle, 3 s settle,
  250 ms watch debounce, 2-miss dead threshold.
- **Fire-and-forget hooks.** Write-and-exit, never blocking.
- **A durable local landing zone.** Keep the concept; change the medium.
- **Launch claims + surface binding** — reframed as the attachment layer.

### Cut

- **SQLite, entirely** → spool dir + one cursor file.
- **The event ledger + reducer.** An inbox is not append-only history. Drain, relay, delete — which removes the
  reduction pass, the prune functions and the retention question at once.
- **`local_chats`, all 36 columns.** The server owns chats; the daemon rebuilds its working set each tick.
- **Observer shadow columns + disagreement log** (`statusesDisagree`, `ObservedShadow`, `observerCreated`).
  A research instrument for choosing between two status models; pick one and it's dead weight.
- **`cmux_trace`**, and launch claims living inside the lifecycle store.
- **`chatSync` dirty-cursor + `isRepresentable`/skip bookkeeping** (`daemon/src/v2/chatSync.ts`).
  Snapshot PUT has no cursor to drift, nothing to storm, nothing to permanently skip.

### Add

- **Recency window + cap + `truncated`.** The missing bound.
- **`chats.cmux_ref` → nullable `handle`.** The single change that unblocks bare-terminal detection.
- **Process identity `(pid, start-time)`.**
- **Server-side status function + evidence column.**
- **Hook health check on launch.** Verify the hook is still installed and its command path still resolves.

### Weight

| | Before | After |
| --- | --- | --- |
| Lines (store + observer + sync) | 3,441 | ~1,000 |
| Local tables | 4 | 0 (a spool dir + one JSON file) |
| Status models | 2 | 1 |
| Endpoints carrying chat state | several | 1 |

---

## 9. Debug UI — Chat Inspector

Under this architecture it is a **pure server read**: observations, evidence and relayed events all land in
Postgres. No second data path, no SQLite-reading IPC, no tiering.

- **Health strip first** (above the table): last snapshot age, machine, window + cap, coverage
  (`complete` / `partial`), chats in window, **spool backlog**. A stale snapshot means every row below it is
  fiction, so that must be legible before any individual chat is. Spool backlog is the only early warning that
  the daemon stopped draining.
- **Table:** Chat (title + cwd + session id on a second line) · Harness · **Existence / Activity / Block**
  grouped under one "observed on machine" header · Status (derived, outside the group) · Seen · Attached.
- **Filters:** all / live / blocked / unattached / stale evidence.
- **Row drawer:** evidence key-values (source, process, mtime, cursor offsets, block raised/expires) and the
  relayed event tail.
- **Placement:** separate dev-gated window — same renderer bundle, `?view=inspector` branch in
  `desktop/src/renderer/main.tsx`, a second `BrowserWindow`, ⌘⌥I behind the existing `isDev` flag.
- **Server work:** client-facing `GET /chats` (join `chats → machines` for ownership, mirroring
  `server/src/routes/assignments.ts`; `ownedChat` already exists in `server/src/routes/helpers.ts`).
  Realtime is already wired — the `chats` NOTIFY trigger ships in `server/drizzle/0001_triggers.sql:71` and
  `desktop/src/renderer/lib/server/queryKeys.ts` already maps the table to `["chats"]`.

**Build it during the rework, not after.** The health strip and the axes are the instruments for telling
whether the new pipeline is behaving.

### What shipped

Built as specified (`desktop/src/renderer/inspector/`, opened with ⌘⌥I from
`openInspectorWindow` in `desktop/src/main/main.ts`). Three deviations, all
forced by what the data can and can't support:

- **Snapshot coverage had to be persisted.** §7's `window` block — `since`,
  `cap`, `truncated` — was validated and then dropped on the floor, so the
  health strip's window / cap / coverage fields had nothing to read. The
  snapshot endpoint now writes them to `machines.chat_snapshot_at` /
  `chat_window_since` / `chat_window_cap` / `chat_window_truncated`
  (migration `0007`). Coverage is a property of the tick, not of any chat row,
  which is why it lives on the machine.
- **Spool backlog is NOT shown**, because it genuinely isn't knowable server-side:
  the daemon drains its spool dir into the snapshot's `events` array and never
  reports the dir's depth. The strip says "not reported" rather than rendering a
  zero, which would be a permanently green early-warning light. Reporting it
  means adding a counter to §7's `window` block and to the daemon's tick.
- **`GET /chats` grew two things**: the names behind the ids (`machineName`,
  `projectName`, and the `task` the chat serves, resolved through
  `assignments.chat_id`), and a sibling `GET /chats/:id/events?limit=` for the
  drawer's relayed tail — per-chat and lazy, so the list never pays for it.

Two implementation notes worth keeping:

- `before-input-event` (where the ⌘⌥I accelerator lives) does **not** fire for
  Playwright/CDP-dispatched keys. `webContents.sendInputEvent` does traverse the
  native path — that is how `desktop/e2e/check-chat-inspector.mjs` drives it.
- The main-held WS previously pushed only to `mainWindow`. `initHitchServer` now
  takes `getWindows` and broadcasts, or the second window would silently go
  stale.

---

## 10. Sequencing

| Phase | Work | Est. |
| --- | --- | --- |
| **0** | Wire `pruneReducedEvents` / `pruneCmuxTrace` into the tick; purge the 747 legacy rows. Pure bug fix, no design needed. | hours |
| **1** | Give existence back to the machine: flip `preferObserver`, delete the "`session.ended` heals a dead chat" path. Re-run the disagreement query to measure. Reversible. | ~1 day |
| **2** | Snapshot endpoint + server-side status function + evidence storage. Daemon stops deciding. | ~3 days |
| **3** | Replace SQLite with the spool dir + cursor file; delete `local_chats`, the reducer, the shadow columns, `cmux_trace`. Add the disposability test to CI. | ~2 days |
| **4** | Nullable `handle`; move launch claims to the attachment layer; add the observation-layer lint rule. | ~1 day |
| **5** | Chat Inspector window. **Done** — see §9 "What shipped". | ~1 day |

Phases 0 and 1 are worth shipping immediately regardless of the rest — 0 is a bug, 1 is a boolean, and 1 gives
a before/after measurement to validate the bigger move.

If rewriting rather than converging: the sensing code survives either way, but unpicking the reducer and the
store is probably slower than rewriting the loop around the sensors we already have.

### What actually landed

Phases 0 and 1 were overtaken: rather than fixing and then flipping the old
model, phase 2 built the snapshot endpoint and phase 3 rewrote the loop around
the sensors (the "rewrite" fork above), which deleted the prune question and the
`preferObserver` flag outright.

- **Phase 2 — done.** `PUT /daemon/machines/:id/chat-snapshot`, the three-axis
  columns, `deriveChatStatus`, `chat_events`, and a client-facing `GET /chats`.
- **Phase 3 — done.** Hooks write to `<appSupport>/events/`; the daemon drains
  it, keeps `cursors.json`, and PUTs a snapshot every tick. The event ledger,
  the reducer, `observed_files`, the observer shadow columns, `chatSync` and
  `chatLifecycleProducers` are deleted; `npm -w @hitch/daemon run
  smoke:chat-disposability` is the CI disposability test.
- **Phase 4 — done.** `chatLifecycleStore.ts` and `local_chats` are DELETED, and
  with them `cmux_trace` and the transitional `reconcilerBridge`. The daemon
  holds no chat model at all: `<appSupport>/events/`, `cursors.json` and
  `launches.json` are the only local state. What replaced each piece:
  - **`daemon/src/attachment/`** — the layer §4 asks for, alongside the
    launchers. It owns the durable launch records, claude pre-registration, the
    codex nonce→thread join, and the assignment→chat link.
  - **Spawn.** Claude's session id is known up front, so the chat is
    pre-registered through the SNAPSHOT with `existence: "pending"` — this is
    where `pending` starts being produced — and the server's upsert on
    `(machine, harness, session)` means discovery lands on that same row moments
    later. Codex gets NO row at spawn: its thread doesn't exist yet, so the
    assignment reads `spawning` with no chat until the hook event arrives.
    Honest, and bounded by the launch record's 10-minute TTL, past which the
    assignment is marked `dead` rather than wedging.

### The codex join: a launch nonce, not a pane (2026-07-26)

Codex has no `--session-id` to pin (verified absent on codex-cli 0.145.0), so
its thread id can only be learned after the fact. The first implementation
learned it from the cmux **surface id**: stamp the pane onto the launch record
before the command runs, have the hook report `CMUX_SURFACE_ID`, join the two.

That was deterministic but wrong in shape. It made a chat's IDENTITY a function
of the environment the chat happened to be running in — a codex chat outside
cmux could never be attached at all, and a terminal's pane model sat in the
identity path, which is exactly the coupling §4 exists to prevent.

**The join key is now `HITCH_LAUNCH_ID`** — the launchId the reconciler already
mints, exported on the codex command as a shell assignment prefix. Codex hands
its process environment to every hook process it spawns, so the hook reports our
nonce next to codex's own `session_id`, and the daemon's join is a lookup by
primary key. Three properties follow by construction:

- a chat Hitch didn't launch carries no nonce and is never attached (correct —
  it isn't ours), so no cwd/timestamp/newest-thread heuristic is needed;
- concurrent launches carry different nonces and cannot collide;
- the same join works in cmux, an editor, a bare shell, or anything added later.

cmux is now asked only *where to display* a chat, never *which chat it is*.

Codex's **`SessionStart`** hook was added to the codex plan at the same time. It
fires at session creation carrying `session_id`, which is earlier than codex's
own catalog (`state_5.sqlite` is only written a moment after the first prompt) —
so the pending window shrinks from "until the user types" to "until the session
boots". The nonce rides on every codex event, not just `SessionStart`, so a lost
spool write is repaired by the next hook rather than stranding the assignment.

**Deferred backstop.** Identity currently depends on hooks; if every hook were
lost the chat is still observed but never attached, and that is surfaced rather
than guessed at. A hooks-free repair exists and is verified: `ps eww -p <pid>`
exposes a codex process's environment (the nonce) and `lsof -p <pid>` its open
rollout file, whose filename contains the thread id — an exact pid→(nonce,
thread) join. Both batch across pids in one call, and the FD stays open while the
session is idle. If built, `pid→thread` belongs to the OBSERVER (machine truth,
and it upgrades `liveness.ts`'s "corroboration, not chat identity") while
`pid→nonce` stays in ATTACHMENT — the observer must never learn what a Hitch
launch is.
  - **`deriveObserved`** reads the server chat's `status` + `existence` instead
    of a local row; **close/focus** resolve through the chat's `handle`.
  - **Legacy routes gone.** `POST/PATCH /daemon/chats`, the `cmuxRef` wire alias
    and the `session_id` lift are deleted. `GET /daemon/chats` stays (the
    reconciler and focus read it); the snapshot PUT is the only writer.
  - **The boundary is enforced**: `npm -w @hitch/daemon run
    smoke:observer-boundary` walks the module graph from
    `daemon/src/observer/` and fails on any path to `launchers/`, `cmux.ts` or
    `attachment/` — transitively, which `no-restricted-imports` would not catch
    (and the repo has no eslint to hang it off).
- **Phase 5 — done**, and landed *before* phase 4 (they were built in parallel;
  the Inspector merged as #116, this as #117). See §9 "What shipped" for its
  three deviations. Phase 4 is the last of the six, so **the rework is complete**
  — what remains are the §11 open questions, not unbuilt phases.

---

## 11. Open questions

1. **How far back should the recency window go?** 24 h matches the field and covers "I stepped away overnight."
   Longer turns Hitch from a live monitor into a session browser. This is the one knob that decides how big the
   working set gets.
2. **Rewrite or converge?** See above.
3. **Does `block` become its own column,** separate from `status`? A chat can be working *and* blocked;
   collapsing them into one enum is what forces today's awkward "needs-input folds to working" comparison in
   `daemon/src/observer/derive.ts`.
4. **Do relayed events land in Postgres?** ~1.5k/day per machine is nothing and it makes the Inspector complete.
   The alternative is relaying observations only and accepting the "why" stays local.

---

## 12. Useful queries

Disagreement rate on the current store:

```sh
cd ~/Library/Application\ Support/Hitch\ Dev
sqlite3 -header chat-lifecycle.sqlite "
select count(*) total,
       sum(case when observed_status is null then 1 else 0 end) no_observation,
       sum(case when observed_status is not null
                 and (case when status='needs-input' then 'working' else status end) <> observed_status
                then 1 else 0 end) disagree
from local_chats where ended_at is null;"
```

Store size / retention:

```sh
sqlite3 chat-lifecycle.sqlite "
select 'chat_events', count(*) from chat_events
union all select 'local_chats', count(*) from local_chats
union all select 'never-synced', count(*) from local_chats where server_chat_id is null
union all select 'oldest_event', datetime(min(observed_at)/1000,'unixepoch') from chat_events;"
```
