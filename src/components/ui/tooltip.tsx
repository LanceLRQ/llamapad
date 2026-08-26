"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

/**
 * Base UI Tooltip 包装（UX P1 U20，shadcn base-nova 风格，对齐 dialog.tsx 的
 * 组合方式）。全站首个 tooltip 使用方是参数表单的 Info 图标提示——hover 与
 * 键盘 focus 都能触发（Trigger 天然可聚焦），Esc 关闭由 Base UI 处理。
 * 不包 Provider：延迟等参数按需在使用处经 <Tooltip delay> 传（默认即可）。
 */

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  children,
  side = "top",
  ...props
}: TooltipPrimitive.Popup.Props & { side?: TooltipPrimitive.Positioner.Props["side"] }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={6} collisionPadding={8}>
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 max-w-72 rounded-md bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent }
