import { existsSync } from "node:fs";
import { Folder } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Card, CardContent } from "@/components/ui/card";
import { formatSize, toGigabytes } from "@/lib/format";
import { FILES_VIEW_ALL_KEY, FILES_VIEW_META_KEY, resolveFilesView } from "@/lib/files-view";
import { getDb } from "@/server/db";
import { resolveModelFiles } from "@/server/fsScanner";
import { getFilesTree } from "@/server/filesApi";
import { listFileMeta } from "@/server/fileMeta";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { getModelsHost } from "@/server/panelConfig";
import { createModelRepo } from "@/server/repo/models";
import { FileMetaTable } from "./file-meta-table";
import { FilesTable, type FilesGroup } from "./files-table";

// db + 运行状态 + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 运行中模型引用的 relPath 集合（gguf + mmproj，glob 展开）：与 T10 的
 * 引用判定同源（精确字符串相等 + glob 展开），这些文件的删除按钮在
 * SSR 即禁用（LOCKED 连 force 也不放行，无需等点击后再查）。
 */
async function runningLockedPaths(modelsRoot: string): Promise<Set<string>> {
  const running = (await getRuntimeService().getRuntimeStatus()).running;
  if (running === null) return new Set();

  const model = createModelRepo(getDb()).getModel(running.model);
  if (model === null) return new Set();

  const locked = new Set<string>();
  for (const configured of [model.gguf_file, model.mmproj_file]) {
    if (configured === undefined) continue;
    if (configured.includes("*") || configured.includes("?")) {
      for (const f of resolveModelFiles(modelsRoot, configured).files) locked.add(f.rel);
    } else {
      locked.add(configured); // 精确引用与磁盘无关（文件缺失也算引用）
    }
  }
  return locked;
}

/**
 * 文件浏览页（M1 Task 11；M16 T6 改二级栏 + 单表 + 元信息升格）：命名空间从
 * 「每空间一张 Card」收进左侧二级栏切片，「文件元信息」从页面底部的附属
 * Card 升格为二级栏一个独立可点的格子（RECORDS 分组），与命名空间平级——
 * 它原来压在整棵文件树最下面，用户很容易根本不知道这张表存在。
 *
 * 命名空间清单 = db 的 listNamespaces() 并入 tree 里出现但 db 没有的空间名
 * （理论上不该发生，防御性并入），排序后使用——这样 db 里注册了但磁盘上
 * 还没建目录的命名空间也会出现在二级栏（计数 0），而不是"配置存在但无处
 * 可见"。
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ ns?: string }>;
}) {
  const t = await getTranslations("pages.files");
  const { ns: rawNs } = await searchParams;

  const root = getPanelModelsRoot();
  const rootHost = getModelsHost();
  const tree = getFilesTree(getDb(), root);
  const locked = await runningLockedPaths(root);
  // 文件元信息（T3b，设计 §3）：与物理文件树分开取——file_meta 一行是逻辑条目
  // （单文件或分片组 glob），孤儿行对应的物理文件已不在磁盘上，天然不在 tree 里
  const fileMetaEntries = await listFileMeta(getDb(), root);

  const dbNamespaces = createModelRepo(getDb()).listNamespaces();
  const treeNamespaces = tree.map((g) => g.namespace);
  const allNamespaces = Array.from(new Set([...dbNamespaces, ...treeNamespaces])).sort();

  // ns 非法（拼错 query、已删除的空间、字面量 "all"）一律落回「全部文件」；
  // "@meta" 是元信息格专属键，判定顺序与理由见 lib/files-view.ts
  const view = resolveFilesView(rawNs, allNamespaces);
  const current =
    view.kind === "namespace" ? view.namespace : view.kind === "meta" ? FILES_VIEW_META_KEY : FILES_VIEW_ALL_KEY;

  const totalFiles = tree.reduce((n, g) => n + g.files.length, 0);
  const totalBytes = tree.reduce((n, g) => n + g.files.reduce((s, f) => s + f.size, 0), 0);
  const rootExists = existsSync(root);
  const missingCount = fileMetaEntries.filter((e) => e.isOrphan).length;

  const treeByNs = new Map(tree.map((g) => [g.namespace, g.files]));

  const navItems = [
    {
      key: FILES_VIEW_ALL_KEY,
      name: t("navAll"),
      lead: { kind: "count" as const, value: totalFiles },
      meta: formatSize(totalBytes),
      // 全局只跑一个模型，「谁在跑」是唯一的全局事实——一旦按空间切片就
      // 看不见，所以「全部文件」这一格也要挂运行中绿点（对齐模型页做法）
      marker: locked.size > 0 ? { tone: "running" as const, title: t("navRunningTooltip") } : undefined,
    },
    ...allNamespaces.map((name) => {
      const files = treeByNs.get(name) ?? [];
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      const nsLocked = [...locked].some((rel) => rel.startsWith(`${name}/`));
      return {
        key: name,
        name,
        lead: { kind: "count" as const, value: files.length },
        meta: formatSize(bytes),
        marker: nsLocked ? { tone: "running" as const, title: t("navRunningTooltip") } : undefined,
      };
    }),
    {
      key: FILES_VIEW_META_KEY,
      name: t("fileMetaTitle"),
      lead: { kind: "count" as const, value: fileMetaEntries.length },
      meta: missingCount > 0 ? t("navMetaMissing", { count: missingCount }) : t("navMetaOk"),
      marker:
        missingCount > 0
          ? { tone: "alert" as const, title: t("navMetaMissingTooltip", { count: missingCount }) }
          : undefined,
    },
  ];

  // 分隔线钉在第一个真实空间前 + "@meta" 前：allNamespaces 恒非空（main 是
  // 系统不变量），这里仍加个空数组兜底防御一手（同 models/page.tsx 的做法）
  const groups = [
    ...(allNamespaces.length > 0 ? [{ beforeKey: allNamespaces[0], label: "NAMESPACES" }] : []),
    { beforeKey: FILES_VIEW_META_KEY, label: "RECORDS" },
  ];

  // 当前切片：全部文件视图用完整 tree；命名空间视图只取该空间一组——db
  // 注册了但磁盘上还没建目录的命名空间也要给出一个空分组，切过去应该看到
  // "这里还没有文件"，而不是渲染出错
  const sliceGroups: FilesGroup[] =
    view.kind === "namespace" ? [{ namespace: view.namespace, files: treeByNs.get(view.namespace) ?? [] }] : tree;
  const sliceFiles = sliceGroups.flatMap((g) => g.files);
  const sliceLockedCount = sliceFiles.filter((f) => locked.has(f.rel)).length;

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉。这是 T1→T11 迁移期的过渡做法，T4b 之后
    // 各页统一处理，届时这段注释与负边距一起删。
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full">
      <SecondaryNav
        kicker="FILES"
        title={t("title")}
        items={navItems}
        queryKey="ns"
        current={current}
        groups={groups}
        footer={
          <p className="mt-auto px-4 pt-3.5 pb-4 text-xs text-muted-foreground">
            {t.rich("rootHint", {
              panel: root,
              host: rootHost,
              code: (chunks) => (
                <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                  {chunks}
                </code>
              ),
            })}
          </p>
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={Folder}
          title={view.kind === "namespace" ? view.namespace : view.kind === "meta" ? t("fileMetaTitle") : t("navAll")}
          subtitle={
            view.kind === "namespace" ? t("navNsSub") : view.kind === "meta" ? t("navMetaSub") : t("navAllSub")
          }
          stats={
            view.kind === "meta"
              ? [
                  { value: fileMetaEntries.length, label: t("statRecords"), tone: "hot" as const },
                  { value: missingCount, label: t("statMissing") },
                ]
              : [
                  { value: sliceFiles.length, label: t("statFiles"), tone: "hot" as const },
                  {
                    value: toGigabytes(sliceFiles.reduce((sum, f) => sum + f.size, 0)),
                    unit: "GB",
                    label: t("statSize"),
                  },
                  { value: sliceLockedCount, label: t("statRunning") },
                ]
          }
        />

        {view.kind === "meta" ? (
          <FileMetaTable entries={fileMetaEntries} />
        ) : totalFiles === 0 ? (
          <div className="px-7 py-6">
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Folder className="size-6" />
                </span>
                <p className="text-sm font-medium">{t("emptyTitle")}</p>
                <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
                <div className="flex flex-col items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{t("emptyPathLabel")}</span>
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                    {root}
                  </code>
                </div>
                {!rootExists && (
                  <p className="max-w-md text-xs text-amber-600 dark:text-amber-400">{t("emptyMissingHint")}</p>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <FilesTable
            groups={sliceGroups}
            locked={locked}
            namespaces={allNamespaces}
            groupByNamespace={view.kind === "all"}
          />
        )}
      </div>
    </div>
  );
}
