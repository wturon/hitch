# Changelog

Release notes for Hitch Desktop.

Before cutting a release, move the relevant notes from `Unreleased` into a
versioned section like `## [0.1.1] - 2026-06-03`. The desktop release script uses
that section as the GitHub Release notes.

## [Unreleased]

## [0.1.12] - 2026-06-13

- Replace the raw-markdown task editor with a **friendly, live-preview editor**.
  The task dialog now opens a Notion-style WYSIWYG surface (headings, lists,
  quotes, links, inline and fenced code, markdown shortcuts) with no visible
  markdown markers, while Hitch's frontmatter is kept byte-for-byte intact —
  only the body is edited, and `chat-*`/`status`/`title` are never re-serialized.
  A Notion-style title input sits at the top, the modal stays short by default
  and grows with content (capping at 85vh then scrolling), and a Formatted / Raw
  markdown switch plus Copy task path / Archive / Delete live in the ⋯ overflow
  menu. The dialog can also be closed while a save is still in flight.
- Add a **Light / Dark / System theme toggle**. Dark mode already followed the
  OS; now an Appearance tab in Global settings lets you pin Light or Dark (or
  track the system). The choice is persisted, applied before first paint to
  avoid a flash, and the native window frame and launch background repaint to
  match the active theme.
- **Integrate the macOS title bar** into the app: the board header moves into the
  window's title area for a cleaner, more native top edge, with a stabilized
  header height and no separate header summary row.
- Make each **status column its own vertical scroll container**. The app shell is
  pinned to the viewport and columns scroll their cards independently while the
  header and sidebar stay put, instead of the whole page scrolling once a column
  overflows. Column scroll padding was fixed so card focus rings are no longer
  clipped at the column edges, and columns stretch to fill the available height.
- Replace the "Open in <Harness>" pill on board cards with a **corner harness
  chip**. At rest it's a circular harness avatar whose ring conveys live chat
  status (faint = idle, spinner = working, amber ring + dot = needs input).
  Hovering or focusing a card expands it into an "Open chat ↗" pill. Respects
  `prefers-reduced-motion`.
- Refresh the **built-in starting prompts** and make them first-class: built-ins
  now ship in the app binary and render read-only (locked badge) so they refresh
  with every update, while `preferences.json` stores only your own custom
  prompts. The default execute prompt is renamed **Ship it** (still the default),
  with new "Help me think this through" and "How hard would this be" prompts;
  the dropdown lists built-ins first, then a divider and your custom prompts.
- Remove the hover-revealed project-details gear from sidebar project rows,
  keeping the row quiet.
- Make `.hitch/` folders **self-describing** so a synced folder explains itself
  to anyone (or any agent) who opens it.

## [0.1.11] - 2026-06-10

- Add a persisted **Keep machine awake** sidebar toggle in Hitch Desktop. When
  enabled, Hitch runs `caffeinate -d -i`, restores the setting on app restart,
  and stops the helper process cleanly when the app quits.
- Make Codex chat status hook-driven after the first turn. The daemon no longer
  polls Codex turn history to "heal" working cards, which could see the previous
  completed turn during a live resumed turn and flip the card back to waiting.
  Hitch-launched first turns still settle through the app-server completion
  callback, while resumed turns use Codex lifecycle hooks. Codex hooks now also
  report `needs-input` from `PermissionRequest` and return to `working` on
  `PreToolUse`, matching the third status state already shown in the board UI.
- Show **per-project chat activity** in the sidebar. Each project lists how many
  of its tasks have a chat mid-turn (a grey spinner + count) and how many are
  blocked waiting on you (an amber dot + count), so a project that needs your
  attention stands out at a glance; a fully idle project shows a dash. The
  tallies are aggregated server-side and returned as small per-project counts
  (the sidebar never subscribes to other projects' file contents), and stay live
  as task chat status changes.
- Remove the hover **Archive** shortcut from board cards. Archiving stays
  available from the card's right-click menu and the per-column ⋯ menu, so the
  card surface stays quiet on hover.

## [0.1.10] - 2026-06-07

- Add **starting prompts**: pick a reusable kickoff prompt when delegating a
  task, and manage your prompt library on a new "Starting prompts" settings tab.
  The picker seeds the (still freely editable) instructions — your edits are
  one-off and never write back to the saved preset. Each prompt has an optional
  "Point the agent at the Hitch task" toggle that prepends a task-reference
  preamble at launch (interpolated live, never persisted, so prompts stay lean
  and portable). Hitch seeds two defaults (Default execute, Investigate), and a
  "Manage prompts in settings…" shortcut jumps straight to the tab.
- Add **model and reasoning controls** to task kickoff. Pick the harness's model
  and reasoning/effort level before delegating, alongside the harness and
  starting-prompt pickers. Options are per-harness (Claude effort low–max; Codex
  none–xhigh) and switching harness resets reasoning to that harness's default.
  These params ride the start-chat command only and are never written to task
  frontmatter — kickoff hands them to the harness, which owns them after (cmux
  Claude via `--model`/`--effort`, Codex via `turn/start`). Claude in a VS Code /
  Cursor extension can't accept them at launch, so the controls disable there
  with a note linking to where the preference lives.
- Redesign the compose view as a single prompt-builder surface: one bordered
  composer with a focus ring on the whole box, the starting-prompt picker in the
  header, a borderless instructions textarea in the body, and the agent (harness
  + model) and reasoning chips with the Send button in the footer.
- Redesign **harness settings** as one card per harness — a branded header
  (icon + name + overall status pill) with the run-environment and status-hook
  rows nested inside, instead of a flat stack of equal-weight boxes.
- Add a per-column **⋯ menu** to each board column (shown when the column is
  non-empty) to **Archive all** or **Delete all** tasks in that column. Archive
  remembers each card's original column so Unarchive restores it; Delete all
  arms on the first click and fires on the second.
- Scope the experimental "press Enter to send" editor notice to Claude Code only
  (Codex in VS Code/Cursor auto-submits through its app server, so the notice was
  wrong there), and link the VS Code/Cursor notice to the Harnesses tab in global
  settings where the run-environment preference lives.
- Lower the board's drag activation threshold so cards pick up more readily.

## [0.1.9] - 2026-06-06

- Lay the rails for running each harness in different environments. Claude Code
  and Codex launches now flow through an environment-aware launcher/adapter layer
  in the daemon — behavior is unchanged (Claude Code in cmux, Codex in the Codex
  app), but the daemon now dispatches on `(harness, environment)` instead of a
  hardcoded per-harness switch. Harness settings shows a new "Run environment"
  selector under each harness, ready for more environments (like the VS Code
  extension) to plug in.
- Add **VS Code** and **Cursor** as run environments for Claude Code (experimental).
  Starting or resuming a task opens the editor's Claude Code extension via its URI
  handler. Because the extension owns the session id, the daemon links the task by
  watching Claude's session store (`~/.claude/projects`) and binding the new session
  to the task that launched it — so the card links the moment you send the first
  message and then tracks working/waiting status through the normal Claude hooks,
  exactly like cmux. Your per-harness environment choice persists in a local
  `preferences.json`; leaving it unset keeps today's behavior (cmux / Codex app).
  The URI is delivered through the editor's own CLI (`code --open-url`) so it
  targets VS Code vs Cursor deterministically. The session opens as an editor tab:
  the extension's `/open` deep link always uses the editor surface regardless of
  its sidebar/panel preference, so we can't route it to the sidebar.
- Add **VS Code** and **Cursor** as run environments for Codex. Hitch still starts
  and links Codex tasks through `codex app-server`, then enables the open button
  once the first turn finishes so the user can resume the durable transcript in
  the corresponding editor extension via
  `vscode://openai.chatgpt/local/<thread-id>` or
  `cursor://openai.chatgpt/local/<thread-id>`. Existing linked Codex chats can
  be opened from the board using the same daemon `open-chat` command path as
  other harnesses.
- Fix the info (ⓘ) popover not appearing in the task details modal. The tooltip
  was painting behind the dialog; the `z-index` now sits on the tooltip positioner
  (the fixed-position element that creates the stacking context) so tooltips layer
  above dialogs.

## [0.1.8] - 2026-06-04

- Show a project-board warning when the selected project is not hitched to a
  local folder, with a quick link into the project's Local setup tab.
- Consolidate the sidebar quick links into a fixed-height Global settings
  dialog with tabs for harness setup, local sync logs, device tokens, and app
  updates.
- Show Codex and Claude Code hook status in the sidebar as quiet shortcuts into
  Harness settings, with green configured states and amber not-configured /
  needs-repair states.

## [0.1.7] - 2026-06-04

- Fix a startup crash introduced in 0.1.6. The new cmux-config editing pulled in
  `jsonc-parser`, whose UMD build calls `require("./impl/format")` through a
  binding the bundler couldn't follow — so the require leaked into the shipped
  bundle and threw `Cannot find module './impl/format'` on every launch. The main
  bundler now prefers each dependency's ESM entry, which inlines cleanly. **0.1.6
  is bricked on launch; install this build instead.**
- Fix a crash when clicking "Restart to update". During install the window is
  torn down before the daemon's final state broadcast, and that broadcast wrote
  to the destroyed window (`TypeError: Object has been destroyed`). State and
  updater broadcasts now skip a destroyed window.

## [0.1.6] - 2026-06-04

- Fix the cmux setup dialog. The 0.1.5 "open settings" / "reload" buttons
  couldn't actually work — they went through the very cmux socket that's blocking
  Hitch, so they failed with the same error. The dialog now offers
  **Enable Automation in cmux**, which writes `socketControlMode` into cmux's
  config directly (backing up your original first), then asks you to quit and
  reopen cmux so the new mode takes effect. A Retry button reopens the chat once
  cmux is back, and the "cmux isn't running" case gets an Open cmux button.

## [0.1.5] - 2026-06-03

- Updates now surface in the app instead of interrupting you with a native
  dialog. When a new version is available, an "Update to vX.Y.Z" button appears
  in the sidebar — click it to download, watch progress inline, then "Restart to
  update" when it's ready. Hitch also re-checks hourly while running (not just at
  launch), and the Harness settings dialog has a "Check for updates" button with
  the current version and live status.
- The cmux setup dialog now does the work for you: an "open cmux's Automation
  settings" link jumps straight to the right pane, and "Reload cmux & retry"
  applies the change and reopens the chat — no hunting through menus or ⌘⇧,.
  (Both use cmux's URL-dispatched CLI, so they work even while its socket is in
  the mode that blocks Hitch.)

## [0.1.4] - 2026-06-03

- Guide you through cmux setup when "Open in Claude Code (cmux)" fails. When cmux
  refuses the connection — its default "cmux processes only" mode blocks apps not
  launched from a cmux terminal — Hitch now shows a dialog with the one-time fix
  (Settings → Automation → "Automation", then ⌘⇧, to reload) instead of failing
  silently. A separate message appears when cmux simply isn't running.

## [0.1.3] - 2026-06-03

- Fix GitHub sign-in. OAuth now opens in your system browser and completes via a
  local loopback redirect (RFC 8252) instead of an embedded window, resolving the
  sign-in error left behind when the hosted web app was retired.

## [0.1.0] - 2026-06-03

- Initial beta packaging flow for Hitch Desktop.
