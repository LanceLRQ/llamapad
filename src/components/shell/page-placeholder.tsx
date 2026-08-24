import type { LucideIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Card, CardContent } from "@/components/ui/card";

interface PagePlaceholderProps {
  /** 页面标题（渲染为 h1，由调用方经 getTranslations 翻译后传入） */
  title: string;
  /** 落地里程碑：概览/监控/Chat → M3，模型/文件/设置 → M1，下载 → M2 */
  milestone: "M1" | "M2" | "M3";
  /** 一句话说明该页未来承载的功能（调用方翻译后传入） */
  description: string;
  /** lucide 装饰图标 */
  icon: LucideIcon;
}

/** M0 占位页公共骨架：h1 + 单张 Card（装饰图标 + 里程碑说明） */
export async function PagePlaceholder({
  title,
  milestone,
  description,
  icon: Icon,
}: PagePlaceholderProps) {
  const t = await getTranslations("common");

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-base font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon className="size-6" />
          </span>
          <p className="text-sm font-medium">{t("comingSoon", { milestone })}</p>
          <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}
