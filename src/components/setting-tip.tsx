"use client";

import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 设置项旁的 `?` 提示（M16 T4b）：hover / 键盘 focus 显示一句机制说明，
 * Esc 关闭。放在标题或字段标签的兄弟位置（不嵌进 label，避免交互元素嵌套）。
 * aria-label 兜底读屏；触屏长按/点击由 Base UI 默认行为接管。
 *
 * 与 param-tip.tsx 的 ParamTip（ⓘ）刻意区分：ⓘ 在模型编辑页几十处已绑定
 * 「参数解释」语义，这里的 `?` 用于「设置项的机制说明」，两者视觉上要能区分，
 * 因此另建组件而不复用。
 */
export function SettingTip({
  text,
  content,
}: {
  text: string;
  /** 富文本气泡内容（M19 批 A T2 新增，可选）：给了就渲染它、`text` 退居
   * aria-label；不给则气泡内容也是 text，与改前完全一致。文件页的路径说明
   * 带 `<code>` 与两段路径，纯字符串放不下 */
  content?: ReactNode;
}) {
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
        <HelpCircle className="size-3" />
      </TooltipTrigger>
      {/* max-w-xs break-all：富文本内容常带长路径，不允许换行会把气泡撑出屏幕 */}
      <TooltipContent className={cn(content && "max-w-xs break-all")}>
        {content ?? text}
      </TooltipContent>
    </Tooltip>
  );
}
