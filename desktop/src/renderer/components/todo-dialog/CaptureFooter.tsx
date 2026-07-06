"use client";

import { Kbd } from "@/components/ui/kbd";

// The stage-1 coaching strip for the capture flow.
export function CaptureFooter() {
  return (
    <div className="flex items-center justify-end gap-3 border-t border-[#EDEDED] bg-[#F9F9F9] px-5 py-2.5 dark:border-border dark:bg-muted/40">
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Kbd>⌘⏎</Kbd> Save
      </span>
      <span className="text-[12px] text-muted-foreground/50">·</span>
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Kbd>esc</Kbd> Cancel
      </span>
    </div>
  );
}
