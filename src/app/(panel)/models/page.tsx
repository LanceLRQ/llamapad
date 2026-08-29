import { ArrowRight, Box } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getDb } from "@/server/db";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateModels } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { formatSize } from "@/lib/format";
import { ModelsTable } from "./models-table";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/** 占盘 GB 数值：与 formatSize 同一套精度换算（<100GB 保留 1 位小数，否则
 * 取整），只是这里不像 formatSize 那样按量级切 MB/KB——顶栏这一枚统计固定用
 * GB 单位，小到 0 时交给 formatStat 判空态，这里不用管。 */
function toGigabytes(bytes: number): number {
  const gib = bytes / 1024 ** 3;
  return gib >= 100 ? Math.round(gib) : Math.round(gib * 10) / 10;
}

/**
 * 模型列表页（M1 Task 7；M16 T5 改二级栏 + 单表）：命名空间从「四张 Card
 * 各自一个卡头」收进左侧二级栏切片，四张卡拍平成一张表；状态筛选与常驻新建
 * 入口挂进顶栏与表格上方的工具条。
 *
 * 「全部模型」固定为二级栏第一项且默认选中（不参与 ns 名排序）：面板全局
 * 同一时刻只跑一个模型，「谁在跑」是唯一的全局事实，一旦默认视图被按空间
 * 切片就会看不见，所以必须留一个能看全局的默认视图。
 *
 * 二级栏不加「新建命名空间」入口：命名空间的增删改留在设置页 02.1，一个操作
 * 两个入口只会让人疑惑该用哪个，这里只做切片器。
 */
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ ns?: string }>;
}) {
  const t = await getTranslations("pages.models");
  const { ns: rawNs } = await searchParams;

  const models = await decorateModels(getDb(), getRuntimeService(), getPanelModelsRoot());
  // 全部命名空间（已按名排序）：二级栏列表 + ⋯ 菜单「移动空间」候选共用同一份
  const allNamespaces = createModelRepo(getDb()).listNamespaces();

  // ns 非法（拼错 query，或该空间已被删）一律落回「全部模型」，与
  // resolveSettingsTab 同一兜底思路：给个安全默认，而不是渲染出一个空切片
  const ns = rawNs !== undefined && allNamespaces.includes(rawNs) ? rawNs : "all";
  const sliceModels = ns === "all" ? models : models.filter((m) => m.namespace === ns);

  // 当前运行模型：必须按全量 models 找，不能用 sliceModels——用户切到别的
  // 命名空间查看时，「启动新模型会顶掉谁」这条判断不能因为看的空间变了而失真
  const runningModel = models.find((m) => m.status === "running") ?? null;

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
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full">
      <SecondaryNav
        kicker="MODELS"
        title={t("title")}
        items={navItems}
        queryKey="ns"
        current={ns}
        // 分隔线钉在第一个真实空间前：allNamespaces 恒非空（main 是系统不变量，
        // 见 server/namespaces.ts 顶部注释），这里仍加个空数组兜底防御一手
        groups={allNamespaces.length > 0 ? [{ beforeKey: allNamespaces[0] }] : undefined}
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

        {models.length === 0 ? (
          <div className="px-7 py-6">
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Box className="size-6" />
                </span>
                <p className="text-sm font-medium">{t("emptyTitle")}</p>
                <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
                {/* 空态引导：直达新建模型向导，与下载页空态同款入口 */}
                <Button size="sm" className="mt-1" nativeButton={false} render={<Link href="/models/new" />}>
                  {t("emptyAction")}
                  <ArrowRight className="size-3.5" />
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <ModelsTable
            models={sliceModels}
            namespaces={allNamespaces}
            runningName={runningModel?.name ?? null}
            groupByNamespace={ns === "all"}
          />
        )}
      </div>
    </div>
  );
}
