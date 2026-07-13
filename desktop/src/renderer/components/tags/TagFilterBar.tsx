"use client";

import { useState } from "react";
import { FilterIcon, XIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { tagTint, type TagColorName } from "@/lib/tagColors";
import { isTagFilterActive, type TagFilter } from "@/lib/todos";
import { cn } from "@/lib/utils";
import { TagCombobox, type TagComboboxOption } from "./TagCombobox";

// An applied-filter chip: a tinted tag pill with an × that removes just that tag
// from the AND selection.
function AppliedChip({
  id,
  color,
  onRemove,
}: {
  id: string;
  color: TagColorName;
  onRemove: () => void;
}) {
  const tint = tagTint(color);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[5px] py-[2px] pr-[4px] pl-[7px] text-[11px] font-medium leading-[14px]"
      style={{ backgroundColor: tint.bg, color: tint.text }}
    >
      <span className="max-w-[140px] truncate">{id}</span>
      <button
        type="button"
        aria-label={`Remove ${id} filter`}
        onClick={onRemove}
        className="flex size-3.5 items-center justify-center rounded-[3px] opacity-70 transition-opacity hover:opacity-100"
      >
        <XIcon className="size-3" style={{ color: tint.text }} />
      </button>
    </span>
  );
}

// The toolbar above the todo list: applied tag chips + Clear on the left, and a
// ghost Filter button on the right that opens the multi-select AND filter
// popover (board B).
export function TagFilterBar({
  options,
  filter,
  counts,
  colorOf,
  onToggleTag,
  onToggleUntagged,
  onClear,
}: {
  options: TagComboboxOption[];
  filter: TagFilter;
  counts: { byTag: Map<string, number>; untagged: number };
  colorOf: (id: string) => TagColorName;
  onToggleTag: (id: string) => void;
  onToggleUntagged: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = isTagFilterActive(filter);

  return (
    <div className="flex min-h-6 flex-wrap items-center gap-1.5">
      {filter.untagged && (
        <span className="inline-flex items-center gap-1 rounded-[5px] border border-dashed border-muted-foreground/50 py-[2px] pr-[4px] pl-[7px] text-[11px] font-medium leading-[14px] text-muted-foreground">
          Untagged
          <button
            type="button"
            aria-label="Remove untagged filter"
            onClick={onToggleUntagged}
            className="flex size-3.5 items-center justify-center rounded-[3px] opacity-70 transition-opacity hover:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      )}
      {filter.tags.map((id) => (
        <AppliedChip
          key={id}
          id={id}
          color={colorOf(id)}
          onRemove={() => onToggleTag(id)}
        />
      ))}
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="px-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear
        </button>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            "ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#8F8F8D] transition-colors hover:bg-[#F4F4F3] hover:text-foreground dark:hover:bg-muted",
            active && "bg-[#F4F4F3] text-foreground dark:bg-muted",
          )}
        >
          <FilterIcon className="size-3" />
          Filter
        </PopoverTrigger>
        <PopoverContent align="end" className="p-0">
          <TagCombobox
            mode="filter"
            options={options}
            selected={new Set(filter.tags)}
            counts={counts}
            untaggedSelected={filter.untagged}
            onToggle={onToggleTag}
            onToggleUntagged={onToggleUntagged}
            placeholder="Filter by tag…"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
