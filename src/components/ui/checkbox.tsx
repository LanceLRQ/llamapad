"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // inline-flex 不能省：base-ui 的 Checkbox.Root 渲染成 <span>，默认
        // display:inline，而 inline 元素不吃 width/height——少了这一条，size-4
        // 完全不生效，勾选框会塌成一条 2px 宽的竖线（全站每个勾选框都中招）
        // dark:data-checked:* 这两条不能省，也不能靠调 class 顺序替代：Tailwind 的
        // 胜负由生成样式表里的特异性决定，而非 class 属性里的先后。少了它们，
        // dark:bg-input/30 会盖住 data-checked:bg-primary，深色主题下勾选框变成
        // 深底 + 深色对勾（text-primary-foreground）——选中态只剩边框颜色在传达，
        // 等于"只靠颜色传达含义"。这两条多一个属性选择器，特异性高于 dark:bg-input/30。
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 dark:bg-input/30 dark:data-checked:bg-primary dark:data-indeterminate:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
