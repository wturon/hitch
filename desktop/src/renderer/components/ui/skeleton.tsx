import { cn } from "@/lib/utils"

// Standard shadcn Skeleton — a single pulsing placeholder box. Uses `bg-muted`
// (the token this codebase's ui primitives lean on; see button.tsx) rather than
// newer shadcn's `bg-accent`, so it reads consistently against sibling surfaces.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
