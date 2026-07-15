"use client";

import { PlusIcon } from "lucide-react";

import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { TagPill } from "@/components/tags/TagPill";
import { TagCombobox } from "@/components/tags/TagCombobox";
import {
  nextTagsAfterToggle,
  newTagRegistryContent,
  useTaskTagAssignment,
} from "@/lib/tagAssignment";
import { type TagRegistry } from "@/lib/tagRegistry";

// The task dialog's tag lane: the pill group + an assign combobox, so the
// document view shows and edits the same tags the row does (the parity gap the
// critique flagged). Headless behavior (colors, option union, toggle/create)
// comes from the shared useTaskTagAssignment — the same source the row uses — so
// the two surfaces stay aligned. Persistence is injected: `onWriteTags` sets the
// task's tag set, `onWriteRegistry` persists a new tag's color to config.json.
export function DialogTagLane({
  registry,
  tags,
  onWriteTags,
  onWriteRegistry,
}: {
  registry: TagRegistry;
  tags: string[];
  onWriteTags: (nextTags: string[]) => void;
  onWriteRegistry: (content: string) => void;
}) {
  const { colorOf, buildOptions } = useTaskTagAssignment(registry);
  const options = buildOptions(tags);

  const toggle = (id: string) => onWriteTags(nextTagsAfterToggle(tags, id));
  const create = (id: string) => {
    if (!tags.includes(id)) onWriteTags([...tags, id]);
    const content = newTagRegistryContent(registry, id);
    if (content) onWriteRegistry(content);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5 pr-2.5 pl-5">
      {tags.map((id) => (
        <TagPill key={id} label={id} color={colorOf(id)} />
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
          {tags.length === 0 && "Add tag"}
        </MenuTrigger>
        <MenuContent align="start" className="p-0">
          <TagCombobox
            mode="assign"
            options={options}
            selected={new Set(tags)}
            onToggle={toggle}
            onCreate={create}
            placeholder="Search or create tag…"
          />
        </MenuContent>
      </Menu>
    </div>
  );
}
