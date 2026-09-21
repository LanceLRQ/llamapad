import { Box } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { buildModelsTabItems } from "@/lib/models-tabs";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型区首页（2026-09-21 设计 §3）：进入模型区最先想知道的两件事——哪些模型
 * 在跑、手上有哪些仓库。配置列表已迁往 /models/profiles，本页不按命名空间切片。
 */
export default async function ModelsHomePage() {
  const t = await getTranslations("pages.models");
  const tHome = await getTranslations("pages.modelsHome");
  const tabItems = buildModelsTabItems("/models", t);

  return (
    // 负边距与定高：与 profiles/repos 两页同款过渡做法，见那两处的同款注释
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="MODELS"
        title={t("title")}
        items={tabItems}
        // 本页没有第二层可选集合，queryKey/current 只是满足 props 契约——
        // items 全是 href 型，选中态由各自的 selected 覆盖决定
        queryKey="tab"
        current="home"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader icon={Box} title={tHome("title")} subtitle={tHome("subtitle")} stats={[]} />
        <div className="min-h-0 flex-1 overflow-y-auto" />
      </div>
    </div>
  );
}
