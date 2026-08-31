import { Box } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Card, CardContent } from "@/components/ui/card";
import { getDb } from "@/server/db";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateModels } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { formatSize, toGigabytes } from "@/lib/format";
import { buildModelsTabItems } from "@/lib/models-tabs";
import { ModelsEmptyStateActions } from "./empty-state-actions";
import { ModelsTable } from "./models-table";
import { NamespaceCreateNavButton } from "./namespace-create-nav-button";
import { RepoCreateNavButton } from "./repo-create-nav-button";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型列表页（M1 Task 7；M16 T5 改二级栏 + 单表）：命名空间从「四张 Card
 * 各自一个卡头」收进左侧二级栏切片，四张卡拍平成一张表；状态筛选与常驻新建
 * 入口挂进顶栏与表格上方的工具条。
 *
 * 「全部模型」固定为二级栏第一项且默认选中（不参与 ns 名排序）：面板全局
 * 同一时刻只跑一个模型，「谁在跑」是唯一的全局事实，一旦默认视图被按空间
 * 切片就会看不见，所以必须留一个能看全局的默认视图。
 *
 * 二级栏标题旁挂「＋新建命名空间」入口（阶段 4 D5，见 namespace-create-
 * nav-button.tsx）：命名空间与文件夹解耦后，这里是用户最高频的"顺手建一个
 * 就用"落脚点，增删改的完整管理仍然留在设置页，两者不冲突。
 *
 * 二级栏顶部再挂「配置／仓库档案」两组路由 tab（批 4，见 lib/models-tabs.ts）：
 * 下载与配置解耦后，仓库档案是独立路由 /models/repos，不是本页的一个视图
 * 切换，所以这两项传 href 走真跳转而非写 ?ns= query。标题旁再加一枚「新建
 * 下载」入口（批 6 任务 12 起唤起统一弹层，见 repo-create-nav-button.tsx），
 * 建完仓库档案直接跳详情页选量化，不必先经列表页。
 */
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ ns?: string }>;
}) {
  const t = await getTranslations("pages.models");
  const { ns: rawNs } = await searchParams;

  const models = await decorateModels(getDb(), getRuntimeService(), getPanelModelsRoot());
  // 全部命名空间（已按名排序）：二级栏列表 + ⋯ 菜单「改命名空间」候选共用同一份
  const allNamespaces = createModelRepo(getDb()).listNamespaces();
  // 磁盘全部一级目录：⋯ 菜单「移动文件到…」候选（阶段 1b B6）——与命名空间
  // 是两份完全独立的列表，取自 scanTree 而不是 namespaces 表，口径同文件页
  const allFolders = scanTree(getPanelModelsRoot()).map((g) => g.folder);

  // ns 非法（拼错 query，或该空间已被删）一律落回「全部模型」，与
  // resolveSettingsTab 同一兜底思路：给个安全默认，而不是渲染出一个空切片
  const ns = rawNs !== undefined && allNamespaces.includes(rawNs) ? rawNs : "all";
  const sliceModels = ns === "all" ? models : models.filter((m) => m.namespace === ns);

  // 当前运行模型：必须按全量 models 找，不能用 sliceModels——用户切到别的
  // 命名空间查看时，「启动新模型会顶掉谁」这条判断不能因为看的空间变了而失真
  const runningModel = models.find((m) => m.status === "running") ?? null;

  // 二级栏顶部两组路由 tab（批 4；任务 9 裁定 7 抽成共享函数，与
  // /models/repos、/models/repos/[id] 三处共用一份构造，不再各自抄一遍）：
  // 配置 / 仓库档案，各自独立路由，不写 ?ns= query，选中态按 pathname 判定，
  // 不跟着下面 ns 的 query 判定走（两组语义不同，一个 current 描述不了两组）
  const tabItems = buildModelsTabItems("/models", t);

  const navItems = [
    {
      key: "all",
      name: t("nsAll"),
      lead: { kind: "count" as const, value: models.length },
      meta: formatSize(models.reduce((sum, m) => sum + m.sizeBytes, 0)),
      marker: runningModel ? { tone: "running" as const, title: t("nsRunningDot") } : undefined,
    },
    ...allNamespaces.map((name) => {
      const nsModels = models.filter((m) => m.namespace === name);
      return {
        key: name,
        name,
        lead: { kind: "count" as const, value: nsModels.length },
        meta: formatSize(nsModels.reduce((sum, m) => sum + m.sizeBytes, 0)),
        marker:
          runningModel?.namespace === name
            ? { tone: "running" as const, title: t("nsRunningDot") }
            : undefined,
      };
    }),
  ];

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉（T1→T11 迁移期的过渡做法，对齐设置页，
    // T4b 之后各页统一处理，届时这段注释与负边距一起删）
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，右侧内容列改由自己滚动（见下方 overflow-y-auto）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="MODELS"
        title={t("title")}
        items={[...tabItems, ...navItems]}
        queryKey="ns"
        current={ns}
        titleAction={
          <div className="flex items-center gap-0.5">
            <RepoCreateNavButton folders={allFolders} />
            <NamespaceCreateNavButton />
          </div>
        }
        // 分隔线先分开两组 tab 与命名空间列表，再钉在第一个真实空间前：
        // allNamespaces 恒非空（main 是系统不变量，见 server/namespaces.ts
        // 顶部注释），这里仍加个空数组兜底防御一手
        groups={[
          { beforeKey: "all", label: t("nsGroupLabel") },
          ...(allNamespaces.length > 0 ? [{ beforeKey: allNamespaces[0] }] : []),
        ]}
        // 术语拆分批次补的区分说明：文件页把左侧清单改成了纯磁盘目录（见
        // files/page.tsx），本页这份"空间"仍然是 models.namespace 配置分组，
        // 两边长得像但已经是两件事——不点破的话，用户切完文件页会带着
        // "空间=目录"的旧印象回来看这里，看见同名的空间名对不上磁盘目录会
        // 以为面板出了 bug
        footer={
          <p className="px-4 pt-3.5 pb-4 text-xs text-muted-foreground">{t("nsFolderHint")}</p>
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={Box}
          title={ns === "all" ? t("title") : ns}
          subtitle={ns === "all" ? t("nsAllSub") : t("nsSub")}
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

        {/* 空态卡与 ModelsTable（内部自带 Toolbar）体量差异很大，统一交给这层
            overflow-y-auto 滚动，不必分别在两个分支里各写一遍 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {models.length === 0 ? (
            <div className="px-7 py-6">
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
              runningName={runningModel?.name ?? null}
              groupByNamespace={ns === "all"}
            />
          )}
        </div>
      </div>
    </div>
  );
}
