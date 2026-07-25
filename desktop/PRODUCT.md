# Product

## Register

product

## Platform

web

## Users

A developer working alongside AI coding agents. The primary user orchestrates several agent chats — Claude Code, Codex — across their own projects from a Mac desktop: delegating work, watching it happen live, and steering it. The context is solo and hands-on; one person holding the thread on a fast-growing pile of in-progress work.

Solo is primary, but not the whole story. Because task state lives on a shared realtime server rather than in a branch, the same surface is built to let a **small team share one live view** of in-progress work. Design for the solo developer's flow today without foreclosing that shared, realtime collaboration.

## Product Purpose

Hitch is a desktop task workspace with an agent delegation layer: a realtime server owns the backlog, the desktop app renders it as a live grouped todo workspace with task dialogs and delegation to coding-agent chats, and a local reconciler daemon runs those chats (claude/codex in cmux) and reports back.

It exists so AI agents and humans share one live view of in-progress work without committing it to git: fast, branch-agnostic task state decoupled from slow, branch-bound code state. Success is a developer who can say what they mean, hand it to their agents, and trust that the work stays legible and in step — never locked to a branch, never drifted out of view.

## Positioning

Hitch enables the effortless expression of developer intent. Every screen should shorten the distance between what a developer means and what their agents do with it.

## Brand Personality

**Warm, human, effortless.** Hitch works on deeply technical material — daemons, syncs, agent harnesses — but must never feel clinical or intimidating. Handing work to an agent should feel as natural as saying it out loud: say what you mean and trust that your agents understand you.

The voice is plain and direct, never jargon-forward. The interface is quiet and confident rather than busy or loud. Crucially, the warmth is carried by copy, interaction timing, and generosity of space — not by color, gradients, or decoration. The surface can stay monochrome and restrained and still feel human.

## Anti-references

**Not a busy SaaS dashboard** — no gradient headers, colored stat cards, a badge for every state, or an accent color per feature. Decoration is not clarity.

**Not the AI-product cliché** — no purple/violet gradients, sparkle icons, glowing "magic" borders, or the generic assistant aesthetic. The intelligence is in the workflow, not in the chrome.

**Not Jira** — no configuration mazes, workflow ceremony, or process-heavy chrome that gets between the developer and the work.

Above all, **never overwhelming.** When a screen starts to feel dense or effortful, treat that as the signal that something is wrong.

## Design Principles

**Intent flows; the tool disappears.** Reduce the distance between what the developer means and what the agent receives on every screen. The best interaction is the one the user barely notices.

**Warmth through voice and rhythm, not decoration.** Humanity comes from plain copy, unhurried timing, and generous space — never from colored badges, gradients, or AI-magic flourishes. The monochrome, restrained surface is the canvas that makes the voice legible.

**Trust is earned by legibility.** A developer must see, at a glance, what every agent is doing and where each task stands. Nothing hidden, nothing drifting; state is always visible and always current.

**Say what you mean, no ceremony.** Capture and delegation should never demand structure the developer didn't ask for. The raw file is the source of truth; the UI is a friendly, faithful layer over it — never a replacement that reshapes intent.

**Solo-first, team-ready.** Serve the single developer's flow now, but never in a way that forecloses the shared, realtime, branch-agnostic collaboration the sync model is built to grow into.

## Accessibility & Inclusion

No formal WCAG target — sensible defaults, held honestly. That means legible contrast in both light and dark themes, complete keyboard operability (the app is keyboard-first, with a command palette), and honoring `prefers-reduced-motion` (already in place for the working spinner). Don't design to a compliance level; don't ship obvious accessibility mistakes either.
