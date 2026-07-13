// The named tag palette (Notion-style). The registry (`tasks/config.json`) only
// ever stores a color *name*, never a hex — so this map is the single source of
// truth for what each name renders as, and the one place to extend when the app
// grows a dark theme (add a `dark` register beside `light`).
//
// Each name resolves to a light-mode tint triple:
//   - bg   → the pill background
//   - text → the pill label (and the pill's readable foreground)
//   - dot  → the swatch dot shown in the filter popover / assign submenu
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

export const TAG_COLORS: Record<TagColorName, TagTint> = {
  green: { bg: "#EAF2EA", text: "#47704B", dot: "#BFD8C0" },
  red: { bg: "#F7E9E7", text: "#A05248", dot: "#E4BEB8" },
  orange: { bg: "#F7EDE1", text: "#9A6B35", dot: "#E7CFAE" },
  purple: { bg: "#EFEDF8", text: "#6A62A8", dot: "#CCC7E8" },
  blue: { bg: "#E8F0F6", text: "#43678B", dot: "#B9CEDF" },
  gray: { bg: "#F1F1F0", text: "#6B6B69", dot: "#D6D6D4" },
  // Derived in the same register (muted, low chroma):
  brown: { bg: "#F1EBE4", text: "#7A5C42", dot: "#DCCBB8" },
  yellow: { bg: "#F6F1DE", text: "#82702B", dot: "#E3D8A6" },
  pink: { bg: "#F8EAF0", text: "#9B4A72", dot: "#E7C2D5" },
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
