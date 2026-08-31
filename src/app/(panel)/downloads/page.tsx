import { getDb } from "@/server/db";
import { scanTree } from "@/server/fsScanner";
import { getDownloadManager, getPanelModelsRoot } from "@/server/locators";
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
 *
 * folders（批 6 任务 12）：喂给页头「新建下载」弹层的目录下拉，与
 * models/page.tsx、files/page.tsx 同一口径的 scanTree 结果，本页此前不需要
 * 磁盘目录数据，弹层接通后才新增这一次扫描。
 */
export default async function DownloadsPage() {
  const tasks = getDownloadManager().listTasks();
  const folders = scanTree(getPanelModelsRoot()).map((g) => g.folder);
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
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，右侧内容列改由自己滚动（见 DownloadsView 内的 overflow-y-auto）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <DownloadsView initialTasks={tasks} initialHistory={history} folders={folders} />
    </div>
  );
}
