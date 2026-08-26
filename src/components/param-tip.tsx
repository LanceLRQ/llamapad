"use client";

import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 参数名旁的 Info 提示（UX P1 U20）：hover / 键盘 focus 显示一句解释，
 * Esc 关闭。放在 Label 兄弟位置（不嵌进 label，避免交互元素嵌套）。
 * aria-label 兜底读屏；触屏长按/点击由 Base UI 默认行为接管。
 */
export function ParamTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={text}
            className="inline-flex size-3.5 shrink-0 translate-y-px items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        }
      >
        <Info className="size-3" />
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
