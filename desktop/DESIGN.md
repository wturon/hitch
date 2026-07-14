---
name: Hitch Desktop
description: A quiet, monochrome workspace where humans and AI agents share one live view of in-progress work.
colors:
  ink: "oklch(0.145 0 0)"
  paper: "oklch(1 0 0)"
  primary-ink: "oklch(0.205 0 0)"
  muted-surface: "oklch(0.97 0 0)"
  muted-ink: "oklch(0.556 0 0)"
  line: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  sidebar: "oklch(0.985 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  dark-bg: "oklch(0.145 0 0)"
  dark-surface: "oklch(0.205 0 0)"
  dark-ink: "oklch(0.985 0 0)"
  dark-muted-ink: "oklch(0.708 0 0)"
  sanction-amber: "#F59E0B"
  sanction-amber-ink: "#B45309"
  sanction-amber-ink-dark: "#F59E0B"
  tag-gray: "#F1F1F0"
  tag-brown: "#F1EBE4"
  tag-orange: "#F7EDE1"
  tag-yellow: "#F6F1DE"
  tag-green: "#EAF2EA"
  tag-blue: "#E8F0F6"
  tag-purple: "#EFEDF8"
  tag-pink: "#F8EAF0"
  tag-red: "#F7E9E7"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "1.3"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: "25px"
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "14px"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.6"
rounded:
  pill: "5px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.destructive}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  tag-pill:
    backgroundColor: "{colors.tag-blue}"
    textColor: "#43678B"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
---

# Design System: Hitch Desktop

## 1. Overview

**Creative North Star: "The Clean Desk"**

Obvious, calm, inviting — like sitting down at an extremely clean desk. Nothing is on the surface that doesn't need to be there, so the one thing that matters right now — the task, the agent, the note you're writing — is the only thing that stands out. Hitch works on deeply technical material (daemons, syncs, agent harnesses), but the interface never lets that weight reach the user. It stays quiet so intent can flow: you say what you mean, hand it to your agents, and trust that it's understood.

The system is **monochrome by doctrine**. The entire chrome — sidebar, top bar, lists, dialogs, buttons, editor — is built from a single neutral ramp in OKLCH at zero chroma, light and dark. Color is not decoration here; it is *information*, and it is spent in exactly one place: the muted, low-chroma tag tints a user assigns to categorize their own work. Warmth is carried by voice, timing, and the generosity of empty space — never by gradients, accent washes, or "AI-magic" flourishes. A screen that has started to feel busy or effortful has already failed.

This system explicitly rejects the busy SaaS dashboard (gradient headers, colored stat cards, a badge for every state), the AI-product cliché (violet gradients, sparkle icons, glowing magic borders), and Jira's process-heavy chrome. Familiarity is a feature: the app should read as a precise, native macOS tool a developer already knows how to use.

**Key Characteristics:**
- Monochrome chrome; color reserved for user-assigned tags only.
- Native, quiet, keyboard-first; standard affordances tuned precisely.
- Hairline borders and tonal layering instead of shadows and cards.
- Warmth from copy, spacing, and unhurried motion — not from color.
- Dense where the work is dense (task lists), spacious where it should breathe (the editor).

## 2. Colors

A single neutral ramp carries the whole interface; the only saturated values in the system are one alert red and the muted tag palette.

### Primary
- **Ink** (`oklch(0.145 0 0)`): The near-black foreground for all body text and primary content in light mode. In dark mode it inverts to **Dark Ink** (`oklch(0.985 0 0)`).
- **Primary Ink** (`oklch(0.205 0 0)`): The solid fill of the one true primary button and other high-emphasis affordances. Nearly black, never a brand hue.

### Neutral
- **Paper** (`oklch(1 0 0)`): Pure-white content surface in light mode. In dark mode the app sits on **Dark Bg** (`oklch(0.145 0 0)`) with raised surfaces on **Dark Surface** (`oklch(0.205 0 0)`).
- **Sidebar** (`oklch(0.985 0 0)`): A hair off-white, one tonal step from Paper, so the navigation rail reads as a distinct second layer without a border or shadow doing the work.
- **Muted Surface** (`oklch(0.97 0 0)`): Fills for hover states, code chips, secondary buttons, and inset panels.
- **Muted Ink** (`oklch(0.556 0 0)` light / `oklch(0.708 0 0)` dark): Secondary text — timestamps, captions, placeholder, the spinner arc. Verified to clear 4.5:1 on Paper.
- **Line** (`oklch(0.922 0 0)`): The hairline border and divider color. In dark mode, borders are a low-opacity white (`oklch(1 0 0 / 10%)`) rather than a lighter gray.
- **Ring** (`oklch(0.708 0 0)`): The focus ring, rendered as a 3px `ring/50` halo.

### Secondary — Sanction Amber (the one attention hue)
One warm hue is sanctioned as a **system** color, distinct from the user's tag tints: **Sanction Amber** (Tailwind `amber-500` `#F59E0B`; text `amber-700` `#B45309` on light, `amber-500` on dark). It means exactly one thing — *this needs your attention* — and it appears in exactly three places, all pointing at the same state:

- The **NEEDS YOU** group header in the todo list (small-caps eyebrow + its trailing hairline).
- The **needs-input dot** on a harness chip (an agent is blocked on you).
- The **per-project attention badge** in the sidebar.

Amber is never decorative and never per-feature. It is the calm surface's single raised voice: because everything else is monochrome, one amber mark reads instantly as "here." Do not introduce a second saturated system hue, and do not spend amber on anything that isn't "needs the human now." (This is deliberately narrower than the destructive red, which marks danger, not attention.)

### Tertiary — Tag Tints (the one place color lives)
Nine muted, low-chroma tints in a shared Notion-style register. Each is a triple — background, readable text, and a swatch dot — and each is chosen so no single tag shouts. Canonical values live in `src/renderer/lib/tagColors.ts`; the registry stores only a color *name*, never a hex.

- **Blue** (bg `#E8F0F6`, text `#43678B`), **Green** (bg `#EAF2EA`, text `#47704B`), **Orange** (bg `#F7EDE1`, text `#9A6B35`), **Purple** (bg `#EFEDF8`, text `#6A62A8`), **Pink** (bg `#F8EAF0`, text `#9B4A72`), **Yellow** (bg `#F6F1DE`, text `#82702B`), **Red** (bg `#F7E9E7`, text `#A05248`), **Brown** (bg `#F1EBE4`, text `#7A5C42`), **Gray** (bg `#F1F1F0`, text `#6B6B69`): the unknown/unregistered fallback.

### Destructive
- **Alert Red** (`oklch(0.577 0.245 27.325)` light / `oklch(0.704 0.191 22.216)` dark): The single saturated system color. Reserved for destructive actions and invalid states, always as a tint (`destructive/10` fill, `destructive` text), never a solid red button.

### Named Rules
**The Monochrome Chrome Rule.** Every pixel of app chrome is drawn from the zero-chroma neutral ramp. If a chrome element carries a hue, it is a bug — with exactly three sanctioned exceptions, each carrying *information*, never decoration: a user-assigned **tag tint** (on pills and swatches), **Sanction Amber** (the "needs your attention" state, in its three named spots), and the **destructive red** (danger). Any other hue in chrome is drift.

**The Color-Is-Information Rule.** Color is spent to help a user categorize their own work or to flag one of two system states (needs-attention amber, danger red) — never to decorate ours. There is no accent-per-feature and no status rainbow: a "colored section header" is forbidden *except* the single amber NEEDS YOU eyebrow, whose amber is the state, not a section theme.

> **Known drift to retire:** the dark theme still inherits a shadcn-default `--sidebar-primary` of `oklch(0.488 0.243 264.376)` — a blue-violet. It contradicts the Monochrome Chrome Rule and the AI-cliché anti-reference; neutralize it to the ink ramp.

## 3. Typography

**Body & Display Font:** the system UI sans stack (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI"`). One family carries headings, labels, buttons, and body — no display/body pairing.
**Mono Font:** the system mono stack (`ui-monospace, "SF Mono", Menlo, Monaco, Consolas`) for code blocks, inline code chips, and the syntax-highlighted editor fence.

**Character:** SF Pro on the Mac this app is built for — neutral, legible, invisible. Type does its job and gets out of the way. Hierarchy is built from a tight, fixed px scale, not fluid clamps; users view at a consistent DPI and a heading that shrank inside a sidebar would look worse, not better.

### Hierarchy
- **Headline** (600, 26px, 1.2, -0.01em): The task-dialog document title and top-level editor `h1`. The largest type in the app — a working title, not a hero.
- **Title** (600, 17px, 1.3): Section headings inside the editor (`h2`) and dialog/panel headers.
- **Body** (400, 14.5px, 25px line-height): The editor prose baseline — task bodies and notes. UI chrome runs one notch tighter at 14px (`text-sm`). Prose caps at 65–75ch for readability.
- **Label** (500, 11px, 14px line-height): Tag pills and the smallest metadata. Set sentence-case by default — **not** uppercased-and-tracked — with one sanctioned exception: the **attention-group headers** in the todo list (NEEDS YOU / WORKING / BACKLOG / DONE). See The Eyebrow Exception.
- **Mono** (400, 13px, 1.6): Code fences and inline `code`, the latter as a muted chip at 0.85em with a 4px radius.

### Named Rules
**The One-Family Rule.** A single sans carries everything; a second family only ever appears as monospace for literal code. No display face, no serif accent, no pairing.

**The Working-Title Rule.** The biggest type in the product is a 26px document title. There is no hero type, no clamp above ~26px — this is a tool, not a landing page.

**The Eyebrow Exception.** Uppercased-and-tracked labels are banned everywhere *except* the todo list's four attention-group headers (NEEDS YOU / WORKING / BACKLOG / DONE): 11px/500, uppercase, `0.05em` tracking. They earn it because the groups are the product's core IA — the answer to "what needs me now" — and the tracked eyebrow reads as a structural divider, not a shouted label. Contrast still holds the floor: the neutral headers use **Muted Ink** (`oklch(0.556)`), not a lighter gray, clearing 4.5:1 on Paper. No other eyebrow is sanctioned; if you reach for uppercase-tracked type elsewhere, it's drift.

## 4. Elevation

Flat by default. Depth is built from **tonal layering and hairline borders**, not shadows: the sidebar is one lightness step off the content surface, hover states are a muted-surface fill, and 1px `Line` borders separate regions. The app reads as stacked sheets of paper on a clean desk, not floating cards.

Shadows appear only where an element genuinely leaves the plane — floating surfaces that overlay content: popovers, dropdown and context menus, dialogs, tooltips, and toasts. These use the restrained shadcn shadow vocabulary (soft, low-opacity, small blur), just enough to lift the surface off what's behind it.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow is a response to *leaving the plane* (a menu, a dialog), never decoration on an in-flow element. If a card has a resting drop shadow, it's wrong.

**The Hairline Rule.** Separation is a 1px `Line` border or a tonal step, nothing heavier. Borders are full and even — never a thick colored side-stripe on one edge.

## 5. Components

Built on shadcn primitives over Base-UI (menus, dialogs, buttons) with cmdk for command/combobox surfaces. Every interactive element ships its full state set: default, hover, focus-visible, active, disabled — and loading where it applies. The feel is **quiet and native**: familiar affordances, tuned precisely, so the tool disappears into the task.

### Buttons
- **Shape:** gently rounded, `rounded-lg` (10px); compact sizes step down to 6–8px.
- **Sizes:** default 32px tall (`h-8`, px 10); `sm` 28px, `xs` 24px, plus square icon variants (24/28/32/36px).
- **Primary:** solid **Primary Ink** fill, **Paper** text; hover lightens to `primary/80`.
- **Outline:** Paper surface, `Line` border, Ink text; hover fills with Muted Surface.
- **Ghost:** transparent; hover fills with Muted Surface. The default for icon-only and low-emphasis actions.
- **Destructive:** a `destructive/10` tint with `destructive` text — never a solid red fill.
- **Hover / Focus / Active:** all-property transition; focus shows the 3px `ring/50` halo; active presses down 1px (`translate-y-px`) for a tactile click.

### Chips — Tag Pills
- **Style:** a tinted pill — muted background + darker same-hue text from the tag palette; 5px radius, 11px/500 label, 2px×7px padding. No border.
- **Behavior:** pills form a right-aligned vertical lane across todo rows; more than three collapse to the first three plus a gray `+N`. Untagged rows render nothing — no placeholder. Done rows dim the whole group to 55%.

### Cards / Containers
- **Corner Style:** the 10px `lg` radius; inset panels and chips step down to 6–8px.
- **Background:** Paper (content) or Sidebar (rail); raised surfaces in dark mode use Dark Surface.
- **Shadow Strategy:** none at rest — see Elevation. Depth is a tonal step or a hairline border.
- **Note:** cards are used sparingly and never nested; a flat list on Paper is preferred over a grid of boxes.

### Inputs / Fields
- **Style:** Paper surface, `Line` border, 8px radius, 32px tall; several fields auto-grow with content via `field-sizing: content` (the title and raw-file views).
- **Focus:** border shifts to `ring` with the 3px `ring/50` halo — no glow, no color change.
- **Invalid:** `destructive` border and ring; error text in `destructive`.

### Navigation
- **Style:** a left sidebar rail on the off-white Sidebar surface, draggable as the macOS window region; a top titlebar row with centered view tabs. Active item is a Muted-Surface fill with Ink text; hover is the same fill at rest weight. Keyboard-first, with a ⌘K command palette (cmdk) as the primary way to move.

### Signature Component — The Harness Spinner
A status ring that traces any rounded-full shape: a faint full track with one brighter **Muted Ink** arc traveling around it, drawn as a masked conic gradient so it follows `border-radius` at any width. At rest it's a 28px circle; expanded, it becomes a working pill's animated outline — the same element "stretches" from spinner to pill. Spins at 0.9s linear; under `prefers-reduced-motion` it freezes to a calm, even ring. This is the app's one piece of signature motion, and it conveys state — an agent is working — not decoration.

## 6. Do's and Don'ts

### Do:
- **Do** keep all chrome monochrome — draw every UI surface from the zero-chroma neutral ramp, light and dark.
- **Do** reserve color for user-assigned tags, using the muted, low-chroma tint palette in `tagColors.ts`; keep any new tint in that same register.
- **Do** build depth from tonal steps and 1px `Line` hairlines; keep surfaces flat at rest.
- **Do** use one sans family for everything, on a tight fixed px scale (14–14.5px body, 26px max title); monospace only for literal code.
- **Do** verify body text clears 4.5:1 — Muted Ink is the floor for secondary text and placeholder, not a lighter gray.
- **Do** keep motion in the 150–250ms range, easing out; give every animation a `prefers-reduced-motion` alternative, as the harness spinner already does.
- **Do** exhaust inline and progressive affordances before reaching for a modal.

### Don't:
- **Don't** build a busy SaaS dashboard — no gradient headers, colored stat cards, a badge for every state, or an accent color per feature.
- **Don't** ship the AI-product cliché — no purple/violet gradients, sparkle icons, or glowing "magic" borders. (Retire the inherited dark `--sidebar-primary` violet.)
- **Don't** become Jira — no configuration mazes, workflow ceremony, or process-heavy chrome between the developer and the work.
- **Don't** let a screen become dense or effortful; treat that feeling as the signal something is wrong.
- **Don't** use a thick colored side-stripe (`border-left`/`border-right` > 1px) on rows, cards, or callouts.
- **Don't** use gradient text (`background-clip: text`) or glassmorphism as decoration.
- **Don't** introduce a display or serif face, fluid clamp headings, or type larger than the 26px working title.
- **Don't** give in-flow surfaces a resting drop shadow; shadows belong only to elements that leave the plane.
