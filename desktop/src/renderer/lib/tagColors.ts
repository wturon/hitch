// The named tag palette (Notion-style). The registry (`tasks/config.json`) only
// ever stores a color *name*, never a hex — so this map is the single source of
// truth for what each name renders as.
//
// Each name resolves to a tint triple:
//   - bg   → the pill background
//   - text → the pill label (and the pill's readable foreground)
//   - dot  → the swatch dot shown in the filter popover / assign submenu
//
// The actual color *values* live as CSS custom properties in styles.css, split
// into a light register (:root) and a dark register (.dark). This map points at
// those vars, so a tag pill (which paints them via inline `style`) flips with
// the theme automatically — no theme prop, no re-render. To retune a hue or
// extend either register, edit the `--tag-*` vars in styles.css; to add a hue,
// add it here and in both CSS registers.
//
// green/red/orange/purple/blue/gray are the values used in the Paper design
// (Todos 2.0, board D option 1); brown/yellow/pink are derived in the same
// muted, low-chroma register so the palette reads as one system.

export const TAG_COLOR_NAMES = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export type TagColorName = (typeof TAG_COLOR_NAMES)[number];

export interface TagTint {
  bg: string;
  text: string;
  dot: string;
}

// A `var(--tag-<name>-<slot>)` reference for every named hue. The values (light
// and dark) are defined in styles.css; see the header note above.
function tintVars(name: TagColorName): TagTint {
  return {
    bg: `var(--tag-${name}-bg)`,
    text: `var(--tag-${name}-text)`,
    dot: `var(--tag-${name}-dot)`,
  };
}

export const TAG_COLORS: Record<TagColorName, TagTint> = {
  gray: tintVars("gray"),
  brown: tintVars("brown"),
  orange: tintVars("orange"),
  yellow: tintVars("yellow"),
  green: tintVars("green"),
  blue: tintVars("blue"),
  purple: tintVars("purple"),
  pink: tintVars("pink"),
  red: tintVars("red"),
};

// The unknown/unregistered fallback. A tag present on a task but missing from
// the registry renders as gray — never an error (registry is advisory).
export const DEFAULT_TAG_COLOR: TagColorName = "gray";

// Normalize any stored/typed color name to a known one, falling back to gray.
export function toTagColor(name: string | undefined): TagColorName {
  return name && (TAG_COLOR_NAMES as readonly string[]).includes(name)
    ? (name as TagColorName)
    : DEFAULT_TAG_COLOR;
}

export function tagTint(name: string | undefined): TagTint {
  return TAG_COLORS[toTagColor(name)];
}

// The color-assignment rotation for tags created through the UI (Notion
// behavior): the Nth tag created gets ROTATION[N % len]. Colorful hues come
// first so the first several tags read distinct; gray (the unknown fallback)
// sits last so a freshly-created tag doesn't look unregistered.
export const TAG_COLOR_ROTATION: TagColorName[] = [
  "blue",
  "green",
  "orange",
  "purple",
  "pink",
  "yellow",
  "red",
  "brown",
  "gray",
];

// The next rotation color given how many tags the registry already holds.
export function nextRotationColor(existingCount: number): TagColorName {
  return TAG_COLOR_ROTATION[
    ((existingCount % TAG_COLOR_ROTATION.length) + TAG_COLOR_ROTATION.length) %
      TAG_COLOR_ROTATION.length
  ];
}
