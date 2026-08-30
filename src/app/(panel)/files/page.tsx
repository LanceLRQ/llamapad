import { existsSync } from "node:fs";
import { Folder } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Card, CardContent } from "@/components/ui/card";
import { formatSize, toGigabytes } from "@/lib/format";
import { FILES_VIEW_ALL_KEY, FILES_VIEW_META_KEY, resolveFilesQuery, resolveFilesView } from "@/lib/files-view";
import { getDb } from "@/server/db";
import { resolveModelFiles } from "@/server/fsScanner";
import { buildRefMap, getFilesTree } from "@/server/filesApi";
import { listFileMeta } from "@/server/fileMeta";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { getModelsHost } from "@/server/panelConfig";
import { createModelRepo } from "@/server/repo/models";
import { FileMetaTable } from "./file-meta-table";
import { FilesTable, type FilesGroup } from "./files-table";
import { FolderRenameDialog } from "./folder-rename-dialog";

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
 * 文件浏览页（M1 Task 11；M16 T6 改二级栏 + 单表 + 元信息升格；术语拆分批次
 * 改左侧清单只取磁盘目录）：文件夹从「每个文件夹一张 Card」收进左侧二级栏
 * 切片，「文件元信息」从页面底部的附属 Card 升格为二级栏一个独立可点的
 * 格子（RECORDS 分组），与文件夹平级——它原来压在整棵文件树最下面，用户
 * 很容易根本不知道这张表存在。
 *
 * 文件夹清单只取磁盘（`tree` 即 scanTree 的结果），不再并入 db 的
 * listNamespaces()：真机实测两者早已脱钩（6 个磁盘目录，namespaces 表只
 * 登记了 1 个，11 个模型里 9 个的分组名与文件所在目录名不一致），继续拿
 * db 兜底只会把从未在磁盘建过目录的命名空间也摆到「文件夹」清单里、点进去
 * 却是一格空的——这本身就是自相矛盾的语义（这个格子明明叫"文件夹"却对应
 * 不到任何磁盘位置）。模型页/设置页仍然读 db 的 namespaces 表，那是配置
 * 分组，与本页展示的磁盘目录是两件事，见 models/page.tsx 与
 * settings/namespaces-card.tsx 里补的说明文案。
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string; ns?: string }>;
}) {
  const t = await getTranslations("pages.files");
  // path 是新键；ns 兜底一轮给旧书签用，见 lib/files-view.ts 的 resolveFilesQuery
  const { path: rawPath, ns: rawNs } = await searchParams;
  const rawQuery = resolveFilesQuery(rawPath, rawNs);

  const root = getPanelModelsRoot();
  const rootHost = getModelsHost();
  const tree = getFilesTree(getDb(), root);
  const locked = await runningLockedPaths(root);
  // 文件元信息（T3b，设计 §3）：与物理文件树分开取——file_meta 一行是逻辑条目
  // （单文件或分片组 glob），孤儿行对应的物理文件已不在磁盘上，天然不在 tree 里
  const fileMetaEntries = await listFileMeta(getDb(), root);

  // tree 由 scanTree 产出，folder 已按名排序，无需再排一次
  const allFolders = tree.map((g) => g.folder);

  // query 非法（拼错、已改名/删除的目录、字面量 "all"）一律落回「全部文件」；
  // "@meta" 是元信息格专属键，判定顺序与理由见 lib/files-view.ts
  const view = resolveFilesView(rawQuery, allFolders);
  const current =
    view.kind === "folder" ? view.folder : view.kind === "meta" ? FILES_VIEW_META_KEY : FILES_VIEW_ALL_KEY;

  const totalFiles = tree.reduce((n, g) => n + g.files.length, 0);
  const totalBytes = tree.reduce((n, g) => n + g.files.reduce((s, f) => s + f.size, 0), 0);
  const rootExists = existsSync(root);
  const missingCount = fileMetaEntries.filter((e) => e.isOrphan).length;

  const treeByFolder = new Map(tree.map((g) => [g.folder, g.files]));

  const navItems = [
    {
      key: FILES_VIEW_ALL_KEY,
      name: t("navAll"),
      lead: { kind: "count" as const, value: totalFiles },
      meta: formatSize(totalBytes),
      // 全局只跑一个模型，「谁在跑」是唯一的全局事实——一旦按文件夹切片就
      // 看不见，所以「全部文件」这一格也要挂运行中绿点（对齐模型页做法）
      marker: locked.size > 0 ? { tone: "running" as const, title: t("navRunningTooltip") } : undefined,
    },
    ...allFolders.map((name) => {
      const files = treeByFolder.get(name) ?? [];
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      const folderLocked = [...locked].some((rel) => rel.startsWith(`${name}/`));
      return {
        key: name,
        name,
        lead: { kind: "count" as const, value: files.length },
        meta: formatSize(bytes),
        marker: folderLocked ? { tone: "running" as const, title: t("navRunningTooltip") } : undefined,
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

  // 分隔线钉在第一个真实文件夹前 + "@meta" 前：allFolders 为空只可能发生在
  // models 根整个不存在/为空的场景，这里加个空数组兜底防御一手（同
  // models/page.tsx 的做法，那边的 allNamespaces 恒非空所以没有这层判断）
  const groups = [
    ...(allFolders.length > 0 ? [{ beforeKey: allFolders[0], label: "FOLDERS" }] : []),
    { beforeKey: FILES_VIEW_META_KEY, label: "RECORDS" },
  ];

  // 当前切片：全部文件视图用完整 tree；folder 视图只取该文件夹一组——磁盘
  // 目录清单本身就来自 tree，理论上 treeByFolder 恒能取到，兜底空数组只是
  // 防御性写法（比如并发时磁盘目录被删掉的极端时序）
  const sliceGroups: FilesGroup[] =
    view.kind === "folder" ? [{ folder: view.folder, files: treeByFolder.get(view.folder) ?? [] }] : tree;
  const sliceFiles = sliceGroups.flatMap((g) => g.files);
  const sliceLockedCount = sliceFiles.filter((f) => locked.has(f.rel)).length;

  // 重命名文件夹（B2）确认框要展示"影响几个模型配置"：与 renameFolder 实际
  // 重写引用时用的是同一个 buildRefMap，按目录前缀过滤出全部引用者去重计数——
  // 提前在 SSR 算好，避免打开 Dialog 前再发一次 GET 请求
  const affectedFolderModelCount =
    view.kind === "folder"
      ? new Set(
          [...buildRefMap(getDb(), root)]
            .filter(([rel]) => rel.startsWith(`${view.folder}/`))
            .flatMap(([, refs]) => refs.map((r) => r.modelName)),
        ).size
      : 0;

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉。这是 T1→T11 迁移期的过渡做法，T4b 之后
    // 各页统一处理，届时这段注释与负边距一起删。
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full">
      <SecondaryNav
        kicker="FILES"
        title={t("title")}
        items={navItems}
        queryKey="path"
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
          title={view.kind === "folder" ? view.folder : view.kind === "meta" ? t("fileMetaTitle") : t("navAll")}
          subtitle={
            view.kind === "folder" ? t("navFolderSub") : view.kind === "meta" ? t("navMetaSub") : t("navAllSub")
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

        {/* 重命名文件夹入口（B2）：B1 拿掉 renameNamespace 的 mv 之后用户
            失去了改磁盘目录名的能力，这里补回来。不放进 PageHeader 的
            trailing——那个插槽与 stats 互斥，本页的 stats 一直在用。单独
            起一条窄栏，只在查看具体文件夹时出现 */}
        {view.kind === "folder" && (
          <div className="flex justify-end border-b border-border/50 px-7 py-2">
            <FolderRenameDialog folder={view.folder} affectedModelCount={affectedFolderModelCount} />
          </div>
        )}

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
            folders={allFolders}
            groupByFolder={view.kind === "all"}
          />
        )}
      </div>
    </div>
  );
}
