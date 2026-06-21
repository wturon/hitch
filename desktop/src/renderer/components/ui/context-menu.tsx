"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  ...props
}: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      {...props}
    />
  )
}

function ContextMenuPortal({
  ...props
}: ContextMenuPrimitive.Portal.Props) {
  return (
    <ContextMenuPrimitive.Portal
      data-slot="context-menu-portal"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  children,
  align = "start",
  side,
  sideOffset = 4,
  collisionPadding,
  anchor,
  ...props
}: ContextMenuPrimitive.Popup.Props & {
  align?: ContextMenuPrimitive.Positioner.Props["align"]
  side?: ContextMenuPrimitive.Positioner.Props["side"]
  sideOffset?: ContextMenuPrimitive.Positioner.Props["sideOffset"]
  collisionPadding?: ContextMenuPrimitive.Positioner.Props["collisionPadding"]
  anchor?: ContextMenuPrimitive.Positioner.Props["anchor"]
}) {
  return (
    <ContextMenuPortal>
      <ContextMenuPrimitive.Positioner
        className="z-50 outline-none"
        data-slot="context-menu-positioner"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        anchor={anchor}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "min-w-40 rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPortal>
  )
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  variant?: "default" | "destructive"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        variant === "destructive" &&
          "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuTrigger,
}
