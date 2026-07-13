import { tagTint, type TagColorName } from "@/lib/tagColors";
import { cn } from "@/lib/utils";

// A single tinted tag pill (Todos 2.0, board D option 1): Geist 11px / 500,
// 14px line-height, 2px 7px padding, 5px radius. Colors come from the named
// palette; an unregistered tag resolves to gray via `tagTint`.
export function TagPill({
  label,
  color,
  className,
}: {
  label: string;
  color?: TagColorName;
  className?: string;
}) {
  const tint = tagTint(color);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[5px] px-[7px] py-[2px] text-[11px] font-medium leading-[14px]",
        className,
      )}
      style={{ backgroundColor: tint.bg, color: tint.text }}
    >
      <span className="max-w-[140px] truncate">{label}</span>
    </span>
  );
}

// The tag pills for a todo row: rendered on the row's meta line beneath the
// title (left-aligned, ahead of any status text), so they no longer compete with
// the title for the primary line. Gap 4px, never shrinks — the meta line's status
// text truncates instead. Untagged rows render nothing — no placeholder. More
// than 3 tags collapse to the first 3 plus a gray `+N` pill. DONE rows dim the
// whole group to 55%.
const MAX_PILLS = 3;

// Pure split of a row's tags into the pills shown and the overflow count, so the
// "first 3 + +N" rule is unit-testable without rendering.
export function splitTagPills(
  tags: string[],
  max = MAX_PILLS,
): { shown: string[]; overflow: number } {
  const shown = tags.slice(0, max);
  return { shown, overflow: tags.length - shown.length };
}

export function TagPillGroup({
  tags,
  colorOf,
  dimmed,
}: {
  tags: string[];
  colorOf: (id: string) => TagColorName;
  dimmed?: boolean;
}) {
  if (tags.length === 0) return null;
  const { shown, overflow } = splitTagPills(tags);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1",
        dimmed && "opacity-55",
      )}
    >
      {shown.map((id) => (
        <TagPill key={id} label={id} color={colorOf(id)} />
      ))}
      {overflow > 0 && <TagPill label={`+${overflow}`} color="gray" />}
    </span>
  );
}
