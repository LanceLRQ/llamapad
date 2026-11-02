import { Box } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getDb } from "@/server/db";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateModels } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { toGigabytes } from "@/lib/format";
import { ModelsEmptyStateActions } from "../empty-state-actions";
import { ModelsTable } from "../models-table";
import { NamespaceFilter } from "../namespace-filter";
import { RepoCreateNavButton } from "../repo-create-nav-button";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型模块入口归入主侧栏，命名空间选择与新建入口保留在内容区。
 * 默认展示全部模型，避免按空间切片后漏看其他空间的运行状态。
 */
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ ns?: string }>;
}) {
  const t = await getTranslations("pages.models");
  const { ns: rawNs } = await searchParams;

  const models = await decorateModels(getDb(), getRuntimeService(), getPanelModelsRoot());
  // 全部命名空间（已按名排序）：筛选下拉框 + ⋯ 菜单「改命名空间」候选共用同一份
  const allNamespaces = createModelRepo(getDb()).listNamespaces();
  // 磁盘全部一级目录：⋯ 菜单「移动文件到…」候选（阶段 1b B6）——与命名空间
  // 是两份完全独立的列表，取自 scanTree 而不是 namespaces 表，口径同文件页
  const allFolders = scanTree(getPanelModelsRoot()).map((g) => g.folder);

  // ns 非法（拼错 query，或该空间已被删）一律落回「全部模型」，与
  // resolveSettingsTab 同一兜底思路：给个安全默认，而不是渲染出一个空切片
  const ns = rawNs !== undefined && allNamespaces.includes(rawNs) ? rawNs : "all";
  const sliceModels = ns === "all" ? models : models.filter((m) => m.namespace === ns);

  // 运行中模型：按全量 models 统计，不能用 sliceModels——切到别的命名空间查看时，
  // 「全部模型」选项的运行中标记不能因为看的空间变了而消失
  const runningModels = models.filter((m) => m.status === "running");


  const namespaceOptions = [
    {
      value: "all",
      label: t("nsAll"),
      count: models.length,
      sizeBytes: models.reduce((sum, m) => sum + m.sizeBytes, 0),
      running: runningModels.length > 0,
    },
    ...allNamespaces.map((name) => {
      const nsModels = models.filter((m) => m.namespace === name);
      return {
        value: name,
        label: name,
        count: nsModels.length,
        sizeBytes: nsModels.reduce((sum, m) => sum + m.sizeBytes, 0),
        running: runningModels.some((m) => m.namespace === name),
      };
    }),
  ];

  return (
    // 页头固定，正文使用各页面自身的内部滚动区。
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          action={<RepoCreateNavButton folders={allFolders} />}
          icon={Box}
          title={ns === "all" ? t("title") : ns}
          subtitle={ns === "all" ? t("nsAllSub") : t("nsSub")}
          titleAction={<NamespaceFilter value={ns} options={namespaceOptions} />}
          stats={[
            { value: sliceModels.length, label: t("statModels"), tone: "hot" },
            {
              value: toGigabytes(sliceModels.reduce((sum, m) => sum + m.sizeBytes, 0)),
              unit: "GB",
              label: t("statSize"),
            },
            {
              value: sliceModels.filter((m) => m.status === "running").length,
              label: t("statRunning"),
            },
          ]}
        />

        {/* 滚动权交给下面两个分支各自处理（反馈 4）：ModelsTable 内部把
            Toolbar 固定、只让表格区滚动；空态没有 Toolbar，自己包一层
            overflow-y-auto 即可，两者不能再共用这一层滚动容器 */}
        <div className="flex min-h-0 flex-1 flex-col">
          {models.length === 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              <Card>
                <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Box className="size-6" />
                  </span>
                  <p className="text-sm font-medium">{t("emptyTitle")}</p>
                  <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
                  {/* 空态双动作（I7 修复）：新建下载唤起统一弹层 + 从已有文件新建配置
                      仍走向导——见 empty-state-actions.tsx 头注释的理由 */}
                  <ModelsEmptyStateActions folders={allFolders} />
                </CardContent>
              </Card>
            </div>
          ) : (
            <ModelsTable
              models={sliceModels}
              namespaces={allNamespaces}
              folders={allFolders}
              groupByNamespace={ns === "all"}
            />
          )}
        </div>
      </div>
    </div>
  );
}
