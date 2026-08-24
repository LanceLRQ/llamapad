import { Box } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Card, CardContent } from "@/components/ui/card";
import { getDb } from "@/server/db";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateModels, type ModelView } from "@/server/modelsView";
import { ModelsTable, type ModelGroup } from "./models-table";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/** 模型列表页（M1 Task 7）：server 侧一次装配（不经 HTTP），按命名空间分组交给客户端组件 */
export default async function ModelsPage() {
  const t = await getTranslations("pages.models");
  const models = await decorateModels(getDb(), getRuntimeService(), getPanelModelsRoot());

  // 按命名空间分组（组间按 ns 名排序；组内保持 listModels 的 name 序）
  const byNamespace = new Map<string, ModelView[]>();
  for (const model of models) {
    const bucket = byNamespace.get(model.namespace);
    if (bucket) bucket.push(model);
    else byNamespace.set(model.namespace, [model]);
  }
  const groups: ModelGroup[] = [...byNamespace.entries()]
    .map(([namespace, items]) => ({ namespace, models: items }))
    .sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
        <span className="text-xs text-muted-foreground">
          {t("modelCount", { count: models.length })}
        </span>
      </div>

      {models.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Box className="size-6" />
            </span>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
          </CardContent>
        </Card>
      ) : (
        <ModelsTable groups={groups} />
      )}
    </div>
  );
}
