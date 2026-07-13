"use client";

import { LoaderCircle } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The subtle spinner shown beside a task title while its auto-title (the
// generate-title pipeline) is in flight. Shared by the TodoDialog header and the
// Todos list rows so both surfaces read the same. Hover reveals a small label.
// Callers own the "is it generating?" decision and render this only when true.
export function TitleGenerationSpinner() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <LoaderCircle
          role="img"
          aria-label="Auto-generating title"
          className="size-3 animate-spin text-muted-foreground/50"
        />
      </TooltipTrigger>
      <TooltipContent>Auto-generating title</TooltipContent>
    </Tooltip>
  );
}
