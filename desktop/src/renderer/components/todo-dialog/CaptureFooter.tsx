"use client";

import { cn } from "@/lib/utils";

// The stage-1 coaching strip. It's the only place esc is coached, because it's
// the only place esc destroys anything. The armed variant (first esc) turns the
// whole strip destructive so the discard warning can't be missed (Decision 4).
export function CaptureFooter({ armed }: { armed: boolean }) {
  if (armed) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-destructive/25 bg-destructive/8 px-5 py-2.5">
        <span className="text-[12.5px] font-medium text-destructive">
          Discard this capture?
        </span>
        <span className="text-[12px] text-destructive/90">
          Press <Chip tone="destructive">esc</Chip> again to discard · type to
          keep
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-3 border-t border-[#EDEDED] bg-[#F9F9F9] px-5 py-2.5 dark:border-border dark:bg-muted/40">
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Chip>⌘⏎</Chip> Save
      </span>
      <span className="text-[12px] text-muted-foreground/50">·</span>
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Chip>esc</Chip> Cancel
      </span>
    </div>
  );
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "destructive";
}) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded-[4px] border px-1.25 py-px font-mono text-[10.5px] leading-none",
        tone === "destructive"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {children}
    </kbd>
  );
}
