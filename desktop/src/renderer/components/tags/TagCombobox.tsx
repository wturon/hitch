"use client";

import { useState } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { normalizeTag } from "@/lib/frontmatter";
import { tagTint, type TagColorName } from "@/lib/tagColors";
import { cn } from "@/lib/utils";

export interface TagComboboxOption {
  id: string;
  color: TagColorName;
}

// A 10px rounded swatch dot. Untagged renders a dashed, hollow swatch.
function Swatch({ color, dashed }: { color?: TagColorName; dashed?: boolean }) {
  if (dashed) {
    return (
      <span className="size-[10px] shrink-0 rounded-[3px] border border-dashed border-muted-foreground/60" />
    );
  }
  return (
    <span
      className="size-[10px] shrink-0 rounded-[3px]"
      style={{ backgroundColor: tagTint(color).dot }}
    />
  );
}

// One shared tag combobox, driven by `mode`:
//   - "filter": rows show a right-aligned facet count and a checkmark when
//     selected, plus a pinned Untagged row (AND semantics live upstream).
//   - "assign": rows toggle the tag on a task; a `+ Create` row appears when the
//     typed query matches no existing tag.
// Selection never closes the surface — you can toggle several tags in one open.
export function TagCombobox({
  mode,
  options,
  selected,
  onToggle,
  counts,
  untaggedSelected,
  onToggleUntagged,
  onCreate,
  placeholder,
  autoFocus = true,
}: {
  mode: "filter" | "assign";
  options: TagComboboxOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  // filter mode
  counts?: { byTag: Map<string, number>; untagged: number };
  untaggedSelected?: boolean;
  onToggleUntagged?: () => void;
  // assign mode
  onCreate?: (id: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const normalized = normalizeTag(query);

  // Match on the raw lowercased query AND the normalized (kebab) query, so
  // typing "needs design" still finds the existing `needs-design` id.
  const matches =
    q === ""
      ? options
      : options.filter(
          (o) =>
            o.id.includes(q) || (normalized !== "" && o.id.includes(normalized)),
        );
  const exactExists = options.some((o) => o.id === normalized);
  const showCreate =
    mode === "assign" && !!onCreate && normalized !== "" && !exactExists;

  return (
    <Command
      shouldFilter={false}
      loop
      // Hosted inside a Base UI submenu (assign mode), the menu owns arrow/typeahead
      // keys — stop everything except Escape so cmdk drives its own list and the
      // input receives text, while Escape still bubbles up to close the menu.
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
      className="w-[248px]"
    >
      <CommandInput
        autoFocus={autoFocus}
        value={query}
        onValueChange={setQuery}
        placeholder={placeholder}
        className="h-9 text-[13px]"
      />
      <CommandList className="max-h-[280px] p-1.5">
        {matches.length === 0 && !showCreate && (
          <CommandEmpty className="py-6 text-[13px]">No tags</CommandEmpty>
        )}
        {matches.map((opt) => {
          const isOn = selected.has(opt.id);
          return (
            <CommandItem
              key={opt.id}
              value={opt.id}
              onSelect={() => onToggle(opt.id)}
              className="gap-2.5 px-2 py-1.5 text-[12.5px]"
            >
              <Swatch color={opt.color} />
              <span className="truncate">{opt.id}</span>
              {mode === "filter" && (
                <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground">
                  {counts?.byTag.get(opt.id) ?? 0}
                </span>
              )}
              <CheckIcon
                className={cn(
                  "size-3.5 shrink-0 text-foreground",
                  mode === "filter" ? "ml-1.5" : "ml-auto",
                  isOn ? "opacity-100" : "opacity-0",
                )}
              />
            </CommandItem>
          );
        })}

        {mode === "filter" && onToggleUntagged && (
          <>
            <CommandSeparator className="mx-0 my-1.5" />
            <CommandItem
              value="__untagged__"
              onSelect={onToggleUntagged}
              className="gap-2.5 px-2 py-1.5 text-[12.5px]"
            >
              <Swatch dashed />
              <span className="truncate text-muted-foreground">Untagged</span>
              <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground">
                {counts?.untagged ?? 0}
              </span>
              <CheckIcon
                className={cn(
                  "ml-1.5 size-3.5 shrink-0 text-foreground",
                  untaggedSelected ? "opacity-100" : "opacity-0",
                )}
              />
            </CommandItem>
          </>
        )}

        {showCreate && (
          <>
            {matches.length > 0 && (
              <CommandSeparator className="mx-0 my-1.5" />
            )}
            <CommandItem
              value="__create__"
              onSelect={() => {
                onCreate?.(normalized);
                setQuery("");
              }}
              className="gap-2.5 px-2 py-1.5 text-[12.5px]"
            >
              <span className="flex size-[10px] shrink-0 items-center justify-center">
                <PlusIcon className="size-3 text-muted-foreground" />
              </span>
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="text-muted-foreground">Create</span>
                <span className="truncate font-medium text-foreground">
                  {normalized}
                </span>
              </span>
            </CommandItem>
          </>
        )}
      </CommandList>
    </Command>
  );
}
