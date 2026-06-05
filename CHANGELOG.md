# Changelog

Release notes for Hitch Desktop.

Before cutting a release, move the relevant notes from `Unreleased` into a
versioned section like `## [0.1.1] - 2026-06-03`. The desktop release script uses
that section as the GitHub Release notes.

## [Unreleased]

- Lay the rails for running each harness in different environments. Claude Code
  and Codex launches now flow through an environment-aware launcher/adapter layer
  in the daemon — behavior is unchanged (Claude Code in cmux, Codex in the Codex
  app), but the daemon now dispatches on `(harness, environment)` instead of a
  hardcoded per-harness switch. Harness settings shows a new "Run environment"
  selector under each harness, ready for more environments (like the VS Code
  extension) to plug in.

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
