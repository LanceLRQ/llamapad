import { getTranslations } from "next-intl/server";

import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";
import { DownloadsView, type DownloadHistoryEntry } from "./downloads-view";

// db + 内存下载队列 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 下载管理页（M2 Task 6）：server 侧一次装配初始数据（与 GET /api/v1/downloads
 * 同源——直接调 locators 的 manager + 直查 download_history，不经 HTTP），
 * 交给客户端组件轮询刷新（2s，M3 升级 SSE）。
 */
export default async function DownloadsPage() {
  const t = await getTranslations("pages.downloads");
  const tasks = getDownloadManager().listTasks();
  const rows = getDb()
    .prepare("SELECT * FROM download_history ORDER BY id DESC LIMIT 20")
    .all() as {
    id: number;
    model_name: string;
    files: string;
    total_bytes: number;
    status: string;
    finished_at: number;
  }[];
  const history: DownloadHistoryEntry[] = rows.map((row) => ({
    id: row.id,
    model: row.model_name,
    files: JSON.parse(row.files) as DownloadHistoryEntry["files"],
    totalBytes: row.total_bytes,
    status: row.status,
    finishedAt: new Date(row.finished_at).toISOString(),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
      </div>
      <DownloadsView initialTasks={tasks} initialHistory={history} />
    </div>
  );
}
