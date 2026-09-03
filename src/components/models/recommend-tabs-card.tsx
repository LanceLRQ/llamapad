"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildRecommendTabs,
  defaultRecommendTab,
  showLlmEntry,
  type RecommendTab,
} from "@/lib/recommend-tabs";

/**
 * 「推荐模型配置」卡（批 3）
 *
 * 规则结果与 AI 结果**分两个 tab**，不混排：规则是零成本、进页面就有的；
 * AI 是用户主动花代价换的。混排会模糊这个区别，而这个区别正是用户决定
 * 要不要信任某张卡的依据。
 *
 * **有 README 就渲染这张卡**，即使一套推荐都没有——规则 0 套时的空态
 * 恰恰是 AI 最该出场的地方，把整张卡藏掉等于把入口也藏掉。
 *
 * tab 状态是组件内 state，不进 URL：侧栏 `?view=` 已经占了一级，再叠一个
 * 只为阅读态的参数不值当；入口链接是同组件内回调，不需要 URL 中转。
 */
export function RecommendTabsCard({
  rulesCount,
  llmCount,
  rulesPanel,
  llmPanel,
}: {
  rulesCount: number;
  /** null = AI 从没跑过；0 = 跑完没找到。两者在 tab 上一样，在面板里说法不同 */
  llmCount: number | null;
  rulesPanel: React.ReactNode;
  llmPanel: React.ReactNode;
}) {
  const t = useTranslations("pages.repos");
  const tabs = buildRecommendTabs(rulesCount, llmCount);
  const [tab, setTab] = useState<RecommendTab>(() => defaultRecommendTab(rulesCount));

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Tabs value={tab} onValueChange={(next) => setTab(next as RecommendTab)}>
          <div className="flex items-center gap-3">
            <h2 className="shrink-0 text-sm font-semibold">{t("recommendCardTitle")}</h2>
            <TabsList>
              {tabs.map((item) => (
                <TabsTrigger key={item.key} value={item.key}>
                  {t(item.key === "rules" ? "recommendTabRules" : "recommendTabLlm")}
                  {item.count !== null && (
                    <span className="ml-1 text-muted-foreground">({item.count})</span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            {showLlmEntry(tabs) && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto shrink-0 gap-1 text-muted-foreground"
                onClick={() => setTab("llm")}
              >
                <Sparkles className="size-3.5" />
                {t("recommendTryLlm")}
              </Button>
            )}
          </div>

          {/* 两个面板都保持挂载：AI 面板里可能正在流式生成，切走就丢了 */}
          <TabsContent value="rules" keepMounted>{rulesPanel}</TabsContent>
          <TabsContent value="llm" keepMounted>{llmPanel}</TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
