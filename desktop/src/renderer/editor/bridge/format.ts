// Inline text-format bitmask flags. These mirror Lexical's own TextNode format
// constants (and MDXEditor's FormatConstants) bit-for-bit, so a value produced
// here can be handed straight to `TextNode.setFormat(number)` and read back from
// `TextNode.getFormat()`. We keep our own copy rather than importing Lexical's
// private constants: the bit values are a stable part of Lexical's serialized
// format, and this lets the pure helpers reason about formatting without pulling
// in Lexical.
//
// Only the four formats the sandbox models are declared. Underline, sub/super,
// highlight, etc. are intentionally absent — out of scope, and they'd need marks
// the sandbox doesn't register. Export throws loudly if it sees any other bit.
export const IS_BOLD = 1;
export const IS_ITALIC = 2;
export const IS_STRIKETHROUGH = 4;
export const IS_CODE = 16;

// Every format bit the bridge understands, OR-ed together. Export asserts a
// TextNode carries no bit outside this set (e.g. an underline) — failing loudly
// instead of silently dropping formatting the markdown can't represent.
export const SUPPORTED_FORMATS = IS_BOLD | IS_ITALIC | IS_STRIKETHROUGH | IS_CODE;
