import { existsSync } from "node:fs";
import { Folder } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Card, CardContent } from "@/components/ui/card";
import { formatSize } from "@/lib/format";
import { getDb } from "@/server/db";
import { resolveModelFiles } from "@/server/fsScanner";
import { getFilesTree } from "@/server/filesApi";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { getModelsHost } from "@/server/panelConfig";
import { createModelRepo } from "@/server/repo/models";
import { FilesTable } from "./files-table";

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

/** 文件浏览页（M1 Task 11）：server 直调 getFilesTree（不经 HTTP），分组传 client */
export default async function FilesPage() {
  const t = await getTranslations("pages.files");
  const root = getPanelModelsRoot();
  const rootHost = getModelsHost();
  const tree = getFilesTree(getDb(), root);
  const locked = await runningLockedPaths(root);

  const totalFiles = tree.reduce((n, g) => n + g.files.length, 0);
  const totalBytes = tree.reduce(
    (n, g) => n + g.files.reduce((s, f) => s + f.size, 0),
    0,
  );
  const rootExists = existsSync(root);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
        <span className="text-xs text-muted-foreground">
          {t("fileCount", { count: totalFiles, size: formatSize(totalBytes) })}
        </span>
      </div>

      {totalFiles === 0 ? (
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
              <p className="max-w-md text-xs text-amber-600 dark:text-amber-400">
                {t("emptyMissingHint")}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <FilesTable groups={tree} locked={locked} rootPanel={root} rootHost={rootHost} />
      )}
    </div>
  );
}
