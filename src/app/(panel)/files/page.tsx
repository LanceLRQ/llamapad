import { existsSync } from "node:fs";
import Link from "next/link";
import { Folder, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatSize, toGigabytes } from "@/lib/format";
import { childFolders } from "@/lib/files-tree";
import { FILES_VIEW_ALL_KEY, FILES_VIEW_META_KEY, resolveFilesQuery, resolveFilesView } from "@/lib/files-view";
import { getDb } from "@/server/db";
import { resolveModelFiles } from "@/server/fsScanner";
import { buildRefMap, getFilesTree } from "@/server/filesApi";
import { listFileMeta } from "@/server/fileMeta";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { getModelsHost } from "@/server/panelConfig";
import { createModelRepo } from "@/server/repo/models";
import { CreateFolderDialog } from "./create-folder-dialog";
import { FileMetaTable } from "./file-meta-table";
import { FilesBreadcrumb } from "./files-breadcrumb";
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
 *
 * 多级目录（阶段 3b C3/C4）：`tree` 自上一批起已经递归展开成任意深度，
 * 左侧二级栏只挑一级目录（`childFolders(tree, "")`，递归聚合文件数/占用，
 * 见 lib/files-tree.ts），更深的层级交给右侧面包屑 + 表格里的目录行下钻。
 * `allFolderPaths`（全部层级）与 `topFolders`（仅一级）因此是两个不同用途
 * 的清单，不要混用：前者喂给 resolveFilesView 判断"这个 query 值是不是
 * 某个真实目录"（面包屑可以下钻到任意深度，判断必须覆盖全部层级），后者
 * 才是左侧栏要渲染的行。
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

  // 全部层级的目录路径（含 "main/70b" 这类深层路径，可能含 ""——根目录若有
  // 散落文件才会出现，见 fsScanner.walkTree）：resolveFilesView 判断一个
  // query 值是否命中"真实目录"要覆盖全部深度，面包屑允许下钻到任意层级
  const allFolderPaths = tree.map((g) => g.folder);
  // 左侧二级栏只列一级目录，且文件数/占用是递归总数（C3）：否则一个自己
  // 没有直接文件、内容全在子目录里的一级目录会显示"0 个文件"，比不显示
  // 更让人困惑（不显示至少不会让人怀疑数字算错了）
  const topFolders = childFolders(tree, "");

  // query 非法（拼错、已改名/删除的目录、字面量 "all"）一律落回「全部文件」；
  // "@meta" 是元信息格专属键，空串是根目录，判定顺序与理由见 lib/files-view.ts
  const view = resolveFilesView(rawQuery, allFolderPaths);
  // 左侧栏选中态钉在"一级目录"这一维（取 folder 的首段）：folder 视图的
  // folder 可能是任意深度（面包屑下钻的结果），但左侧栏里没有给每一层都
  // 开一格，选中态应该落在"你现在在哪个抽屉里"，而不是精确到哪一层都不
  // 匹配、导致左侧栏在深层浏览时全部变成未选中（用户会以为自己"跳出"了
  // 这个文件夹）。"" 的首段仍是 ""，根目录/全部文件/元信息三个视图天然
  // 没有对应的一级目录格，此时左侧栏没有任何一行被选中，是预期行为。
  const current =
    view.kind === "folder"
      ? view.folder.split("/")[0]!
      : view.kind === "meta"
        ? FILES_VIEW_META_KEY
        : FILES_VIEW_ALL_KEY;

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
    ...topFolders.map((f) => {
      // rel.startsWith(`${f.name}/`) 本来就是前缀匹配，天然覆盖 f.name 下
      // 任意深度的子目录——多级目录落地后这条判定不用改，确认即可（简报
      // 里点名的第 3 条）
      const folderLocked = [...locked].some((rel) => rel.startsWith(`${f.name}/`));
      return {
        key: f.path,
        name: f.name,
        lead: { kind: "count" as const, value: f.fileCount },
        meta: formatSize(f.bytes),
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

  // 分隔线钉在第一个一级目录前 + "@meta" 前：topFolders 为空只可能发生在
  // models 根整个不存在/为空（或只有根下散落文件、没有任何一级目录）的
  // 场景，这里加个空数组兜底防御一手（同 models/page.tsx 的做法，那边的
  // allNamespaces 恒非空所以没有这层判断）
  const groups = [
    ...(topFolders.length > 0 ? [{ beforeKey: topFolders[0]!.path, label: "FOLDERS" }] : []),
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
  // 提前在 SSR 算好，避免打开 Dialog 前再发一次 GET 请求。根目录（folder
  // === ""）排除在外：根本身不可重命名（见下方渲染逻辑），这里不必为它算
  // 一个永远用不上的数字（`rel.startsWith("/")` 对任何相对路径也恒为 false）
  const affectedFolderModelCount =
    view.kind === "folder" && view.folder !== ""
      ? new Set(
          [...buildRefMap(getDb(), root)]
            .filter(([rel]) => rel.startsWith(`${view.folder}/`))
            .flatMap(([, refs]) => refs.map((r) => r.modelName)),
        ).size
      : 0;

  // 当前目录的直接子目录（C4），恒为 folder 视图算——包含根目录（folder
  // === ""）；「全部文件」/「文件元信息」两个伪视图没有"当前目录"这个
  // 概念，传空数组
  const subfolders = view.kind === "folder" ? childFolders(tree, view.folder) : [];

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉。这是 T1→T11 迁移期的过渡做法，T4b 之后
    // 各页统一处理，届时这段注释与负边距一起删。
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，右侧内容列改由自己滚动（见下方 overflow-y-auto）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="FILES"
        title={t("title")}
        items={navItems}
        queryKey="path"
        current={current}
        groups={groups}
        footer={
          <p className="px-4 pt-3.5 pb-4 text-xs text-muted-foreground">
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
          title={
            view.kind === "folder"
              ? view.folder === ""
                ? t("rootTitle")
                : view.folder
              : view.kind === "meta"
                ? t("fileMetaTitle")
                : t("navAll")
          }
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

        {/* 面包屑 + 新建下载/新建/重命名文件夹入口（C3/C5，B2 起就有的重命名
            沿用这条窄栏）：不放进 PageHeader 的 trailing——那个插槽与 stats
            互斥，本页的 stats 一直在用。只在 folder 视图（含根目录）出现，
            「全部文件」/「文件元信息」没有"当前目录"这个概念，面包屑与
            "在当前位置新建"都无从谈起。重命名单独排除根目录——根本身不是
            一个可以被改名的磁盘目录，见 server/folders.ts 的 renameFolder。
            「新建下载」（阶段 4 E）带上 dir query 直达向导第 3 步的存放位置，
            不做独立的纯文件下载——用户已拍板仍以模型为准，这里只是换个入口。 */}
        {view.kind === "folder" && (
          <div className="flex items-center justify-between gap-3 border-b border-border/50 px-7 py-2">
            <FilesBreadcrumb folder={view.folder} />
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={`/models/new?dir=${encodeURIComponent(view.folder)}`} />}
              >
                <Plus className="size-3.5" />
                {t("newDownloadButton")}
              </Button>
              <CreateFolderDialog parentPath={view.folder} />
              {view.folder !== "" && (
                <FolderRenameDialog folder={view.folder} affectedModelCount={affectedFolderModelCount} />
              )}
            </div>
          </div>
        )}

        {/* 面包屑/工具条留在滚动容器外面（固定不滚）；下面这段才是随视图切换的
            正文——三个分支体量差异很大（元信息表 / 空态卡 / 文件表 + 内部
            Toolbar 都可能超出可视高度），统一交给这层 overflow-y-auto 滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
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
              folders={allFolderPaths}
              groupByFolder={view.kind === "all"}
              subfolders={subfolders}
            />
          )}
        </div>
      </div>
    </div>
  );
}
