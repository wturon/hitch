# Hitch — Sections in a project (design spec)

> Written 2026-07-26 against `af480cc`. Design record: the Paper scratchpad boards S1/S2
> (2026-07-17, "sections direction"), plus the mock at
> https://claude.ai/code/artifact/a19f0ff6-b3a1-4f47-b3f3-eea015318d5e.
> Parent: docs/v2-prd.md. Status: **BUILT** — PR #122. Where the code settled
> somewhere other than this document first proposed, the document has been
> corrected rather than the code; those places are called out inline.

## The problem

Project lists have outgrown a single ordering. Tags + filter are a *query* — they answer "show me
the daemon ones", not "where does this live". Nothing in the list has a stable shape, so past ~20
open tasks the only structure left is chronological: newest capture on top, everything else
sediment. You re-read the list instead of remembering it.

## The decision

User-created **sections** become the only vertical structure in a project's list. A task lives in
exactly one section or in none. **Nothing but you moves a task.**

Sections are *where*; tags are *what kind*. One-to-many exclusive vs. many-to-many cross-cutting —
no overlap, and they compose (a filter is a lens over the structure, not a replacement for it).

## Evidence summary — the server side already shipped

This is not a new primitive. M1 built the whole model and no UI ever used it:

- `sections` table — `id`, `project_id` (cascade), `name`, `sort_order`, timestamps, index on
  `project_id` (`server/src/db/schema.ts:103`).
- `tasks.section_id` — nullable FK, **`on delete set null`**, indexed. The comment already states
  the intended semantics: "deleting a section drops its tasks back to the project root, never
  mass-deletes" (`schema.ts:122-125`).
- Full CRUD at `/sections`, ownership-scoped, list ordered by `sort_order`
  (`server/src/routes/sections.ts`), mounted at `app.ts:46`.
- `taskCreate` and `taskUpdate` both accept `sectionId` (`validation.ts:80,92`); `taskListQuery`
  accepts `section_id`.
- Realtime is wired: `sections_notify_change` NOTIFY trigger (`drizzle/0001_triggers.sql:44`) and
  `TABLE_QUERY_KEYS.sections → ["sections"]` in the renderer's `queryKeys.ts`.
- The CLI's task type already carries `sectionId` (`cli/src/resolvers.ts:15`).

**Estimated server work: zero.** Everything below is desktop renderer.

## The model

| Question | Answer |
| --- | --- |
| Where does a task live? | Exactly one section, or none. `section_id null` = **loose**, rendered first with no header. |
| What moves a task? | Only the user. Not status, not an agent, not automation. |
| Where does capture land? | In the container whose add-row you used, at its top. The global `C` shortcut always files loose. (Revised: this spec first said capture is *always* loose. Every container having its own add-row makes the destination a property of which row you clicked, so capture still never asks a question mid-typing.) |
| What happens to DONE? | Unchanged: one global group at the bottom, 3-item preview. Completed work is a receipt, not structure. |
| Is collapse state synced? | No. `localStorage`, per project, like `tagFilter`. It's a per-machine view preference. |
| Do sections nest? | No. Subtasks stay parked (Will, 2026-07-17). |

## What changes in the UI

### Status stops being a place, and goes back into the chip

Today `deriveTaskGroups` splits open tasks into NEEDS YOU / WORKING / BACKLOG by their latest
assignment's `observedState`, so **rows relocate on their own**. That is the thing sections cannot
coexist with: two competing vertical axes make the list worse, not better.

Status moves into **one instrument per row** — V1's `HarnessChip`, recovered from `ae50282^` (the
V2 cutover deleted it). A 22px brand avatar in a neutral circle, status carried in the *concentric*
ring so brand and status color never sit side by side, expanding inline on row hover to
`Open chat ↗`:

| State | Ring | Extra |
| --- | --- | --- |
| idle | faint `border` at 1.5px | — |
| working | `hitch-spin-ring` — a hard-edged conic arc travelling the ring; freezes to an even ring under `prefers-reduced-motion` | — |
| needs you | `amber-500`, dropping to neutral when expanded | 9px amber dot pinned to the avatar, `ring-2 ring-card` |

Rows with no agent render a **28px empty slot**, so chips and tag pills form a column down the list
rather than ragging.

This deletes `AttentionControl` outright — the `Working` spinner + word, the amber `Needs input`
text, and the `Mark reviewed` button all come off the row. `deriveTaskGroups` survives for `done`
and for the sidebar's project chips; it just stops driving layout, so its tests stay valid.

The CSS the chip needs (`@property --hitch-spin`, `@keyframes hitch-spin`, `.hitch-spin-ring`) is
still in `styles.css:209-250` — it was never removed.

### Section header

Minimal, following Todoist: a hanging disclosure caret, the name at 13.5px/600 **rendered as
typed**, a count, a `···` menu on hover, and a single hairline underneath. No trailing rule
fragment, no uppercase, no status instruments.

A **collapsed** section is the one exception: it shows the chips of any live agents inside it.
Collapsing is how a long project gets short, and the design fails if collapsing can hide an agent
that needs you — but this reuses the chip rather than minting a second status vocabulary.

### Everything else

- **Per-section add row** — existing `AddTaskRow` chrome, no `C` hint (that's the global capture).
- **`+ New section`** at the bottom, quiet, between hairlines.
- **Drag between sections** — whole-row drag exactly like backlog reorder today, now across
  containers. A drop on a row takes that row's place; a drop on the section itself lands at whichever
  end of its list you dropped nearer. (Revised: this spec said the destination "opens a gap".
  `SortableContext` only displaces items in its own context, so it cannot — a hairline above the row
  the drop would land on carries that signal instead.)
- **`Move to ▸`** on the row context menu, from the same `ContextMenuSub` the Tags submenu uses;
  `No section` first, then the sections, check on the current one. This is the only route that works
  from the keyboard, and the only one that reaches a collapsed section.
- **Section `···` menu** — Rename / Move up / Move down / Delete section. Delete confirms with what
  actually happens: *"Its 14 todos stay in the project, unfiled."* (Revised: this spec first promised
  they "move back to the top of the project". `DELETE /sections/:id` only nulls `section_id` and
  leaves `sort_order` alone, so they rejoin the loose list wherever their keys put them — often near
  the bottom. Promising a position we don't deliver is worse than describing the one we do.)
- **Filtering** — a section with no match hides, *unless* it is collapsed and holding a live agent:
  its header is then the only place that agent can appear, and hiding it would reopen the hole the
  collapsed chips exist to close. Matching sections show `3 of 6`. Add-rows and drag stay hidden
  while a filter is active (unchanged).
- **A project with no sections** renders as one uninterrupted list — today's screen minus the status
  groups. Nothing to migrate, no backfill, no empty state to design.

### Deliberately not built

An attention bar or counter above the list. It was in the first draft and cut: it's chrome that
duplicates what the chips already say, and "show only these" is a filter wearing a different hat.

## Implementation

All five ship as V1 — cross-section drag included (Will, 2026-07-26). All in
`desktop/src/renderer/v2/`; server, daemon, and shared are untouched.

### PR 1 — read path
`useSections(projectId)` query (`["sections", projectId]`, the WS invalidation already maps). New
pure module `sectionGroups.ts`: fold `tasks × sections` into `{ loose, sections: [{section, tasks}],
done }`, sorted by `sortOrder` with the same string-compare + id tiebreak `todoGroups.ts` uses.
Render read-only sections; keep NEEDS YOU / WORKING for now. Unit tests on the fold.

### PR 2 — the status collapse + the chip
Delete the NEEDS YOU / WORKING groups and `AttentionControl`. Restore `HarnessChip` from `ae50282^`,
ported off Convex — the markup, the ring, and the expand-on-hover body come over verbatim; only its
two inputs change:

- **State** comes from the `latestAssignmentByTaskId` join the view already builds:
  `pending | spawning | running → working`; `waiting_input → needs-you`;
  `done ∧ reviewed_at null → needs-you`; `done ∧ reviewed → idle`; `dead` or no assignment → the
  empty 28px slot.
- **Click** reuses V2's existing open-chat path, not V1's `useOpenChat`/`CmuxAccessDialog` (both
  deleted): the WS focus relay in `DelegateBar.tsx:204-216` — `wsSend({type:"event",
  event:"focus", machineId, payload:{chatId}})`, gated on `chatId != null && machineId != null`.
  Worth lifting into a shared hook, since the bar and the row now do the same thing.

**This is the behavioral change and the one to sit with.**

### PR 3 — section CRUD
`+ New section` (inline input, `generateKeyBetween(last, null)`), rename in place, delete with the
fallback-worded confirm, reorder via the `···` menu. Optimistic like `useTaskMutations`.

### PR 4 — placement
`Move to ▸` submenu; per-section add rows; capture files into the container whose add-row was used
(the global `C` still lands loose — see the model table). Two sort-order rules need redefining, both
currently written against a single flat backlog:
- `captureSortOrder(backlog)` → prepend within the **target container**.
- `uncheckSortOrder(backlog)` → return to the top of **its own section**, not the project's.

### PR 5 — drag + keyboard
Multi-container dnd-kit: one `DndContext` over every container, a `SortableContext` per section, and
the whole `<section>` as a droppable so the header and add-row aren't a dead band. A cross-section
drop is one PATCH carrying both `sectionId` and `sortOrder`. `onDragOver` only paints the drop
hairline — the move itself happens in `onDragEnd`. Rebuild the `useListKeyboardNav` flat index in
render order — section headers are **not** navigable; per-section add rows are.

Two things about the drop maths are worth carrying forward, because both shipped wrong first:
- A drop that resolves to a CONTAINER means the end of its list you dropped nearer, decided against
  the **first row's top edge** — not the container's midpoint, which inverts for one-row sections.
- The comparison uses a **live pointer coordinate**, tracked with our own `pointermove` listener.
  dnd-kit's `delta` is scroll-adjusted and `activatorEvent` is frozen at drag start, so combining
  them puts the two sides of the comparison in different frames as soon as auto-scroll moves the
  list under the pointer.

## Risks

1. **Losing NEEDS YOU as a destination.** Everything now rests on the chip being findable at the
   right edge of a long list — that's the unproven part, and the reason PR 2 is separable and
   revertible on purpose. Note there is **no backstop**: V2's sidebar has no per-project attention
   count (that was V1/Paper chrome, never ported), so inside a collapsed section the chip is the
   only signal. Hence collapsed headers surfacing their live chips.
2. **Keyboard nav is index-based.** `data-idx` over a flat list; sections make that list
   discontiguous. Highest-bug-density area — worth its own tests.
3. **Sort-order scope.** Two functions assume one flat backlog per project. Missing one gives
   silently wrong placement, not a crash.
4. **The CLI has no section commands.** `hitch task` can't file anything after this ships. Not a
   blocker (the column is optional), but it becomes a real gap once sections carry the structure —
   fold into the CLI-tightening work.

## Open questions

1. **What happens to acknowledgement?** V2 has a state V1's chip never had: the agent finished and
   you haven't looked (`done ∧ reviewed_at null`), today an amber `Mark reviewed` button on the row.
   Folding it into the chip means it reads as "needs you" and is acked by opening the chat rather
   than by a button — quieter, but one-click ack leaves the list. Alternative: keep ack in the row
   context menu.
2. **DONE — global, or per-section?** Spec says global. Per-section is more Todoist-faithful and
   more fragmented.
3. **Section names in the ⌘K palette?** Deferred here.
4. **Does a section ever get its own delegate/prompt default?** Deliberately out of scope; sections
   stay inert structure in V1.
