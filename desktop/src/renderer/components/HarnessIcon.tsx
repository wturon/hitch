import { cn } from "@/lib/utils"
import type { Harness } from "@/lib/chat"
import claudeCodeIconUrl from "@/assets/claudecode.svg"
import codexIconUrl from "@/assets/codex.svg"

// Size is driven by `className` (default size-4).
export function HarnessIcon({
  harness,
  className,
}: {
  harness: Harness
  className?: string
}) {
  const iconUrl = harness === "codex" ? codexIconUrl : claudeCodeIconUrl

  return (
    <img
      src={iconUrl}
      alt=""
      className={cn("size-4", className)}
      aria-hidden
    />
  )
}
