import { PlusIcon } from "lucide-react";

import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { TagCombobox, type TagComboboxOption } from "@/components/tags/TagCombobox";
import { TagPill } from "@/components/tags/TagPill";
import type { TagColorName } from "@/lib/tagColors";

// The V2 task dialog's tag lane (M2 PR 5): the pill group + an assign
// combobox between the header row and the editor — V1's DialogTagLane chrome,
// verbatim. Siblinged because V1's lane is welded to the file registry
// (TagRegistry prop + config.json write callbacks); this one is fully bound
// by the shell against the live row through the SAME useTagMutations handlers
// the row submenu uses (one code path). TagPill/TagCombobox/Menu are the V1
// modules, imported.
export interface DialogTagLaneV2Props {
  /** The live row's tag names, in link order. */
  names: string[];
  colorOf: (name: string) => TagColorName;
  options: TagComboboxOption[];
  onToggle: (name: string) => void;
  onCreate: (name: string) => void;
}

export function DialogTagLaneV2({
  names,
  colorOf,
  options,
  onToggle,
  onCreate,
}: DialogTagLaneV2Props) {
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5 pr-2.5 pl-5">
      {names.map((name) => (
        <TagPill key={name} label={name} color={colorOf(name)} />
      ))}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Edit tags"
              className="inline-flex items-center gap-1 rounded-[5px] px-[7px] py-[2px] text-[11px] font-medium leading-[14px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-3" />
          {names.length === 0 && "Add tag"}
        </MenuTrigger>
        <MenuContent align="start" className="p-0">
          <TagCombobox
            mode="assign"
            options={options}
            selected={new Set(names)}
            onToggle={onToggle}
            onCreate={onCreate}
            placeholder="Search or create tag…"
          />
        </MenuContent>
      </Menu>
    </div>
  );
}
