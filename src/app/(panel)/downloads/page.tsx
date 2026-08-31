import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";
import { DownloadsView, type DownloadHistoryEntry } from "./downloads-view";

// db + 内存下载队列 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 下载管理页（M2 Task 6；M16 T7 改二级栏 + 顶栏，交给 client 组件自己渲染）：
 * server 侧一次装配初始数据（与 GET /api/v1/downloads 同源——直接调 locators
 * 的 manager + 直查 download_history，不经 HTTP），交给客户端组件订阅 SSE
 * 刷新。
 *
 * 本页不读 `?view=`：二级栏的计数与 meta（队列速度、各状态任务数）是每秒变的
 * 实时数据，不能在 server 侧算，SecondaryNav + PageHeader 都下沉到
 * <DownloadsView> 内部用 useSearchParams() 自己读——server 端多传一份
 * initialView 只会多一个可能与 client 不一致的状态源，不如干脆不读。
 */
export default async function DownloadsPage() {
  const tasks = getDownloadManager().listTasks();
  const rows = getDb()
    .prepare("SELECT * FROM download_history ORDER BY id DESC LIMIT 20")
    .all() as {
    id: number;
    batch_id: string;
    label: string;
    files: string;
    total_bytes: number;
    status: string;
    finished_at: number;
  }[];
  const history: DownloadHistoryEntry[] = rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    label: row.label,
    files: JSON.parse(row.files) as DownloadHistoryEntry["files"],
    totalBytes: row.total_bytes,
    status: row.status,
    finishedAt: new Date(row.finished_at).toISOString(),
  }));

  return (
    // 二级栏必须贴到应用外壳的框边：T1 给 main 留了 px-[34px] pt-7 pb-12，
    // 本页在这一层用负边距抵消掉。这是 T1→T11 迁移期的过渡做法，T4b 之后
    // 各页统一处理，届时这段注释与负边距一起删。SecondaryNav / PageHeader
    // 是 <DownloadsView> 内部渲染的（见上方注释），本页只提供这层外壳。
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full">
      <DownloadsView initialTasks={tasks} initialHistory={history} />
    </div>
  );
}
