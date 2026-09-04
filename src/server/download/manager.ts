import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { shardInfo } from "../../core/files";
import { assertFolderInsideRoot } from "../filesApi";
import { getEffectiveProxy } from "../hf/settings";
import { getModelsHost, getPanelConfig } from "../panelConfig";
import { getProxyAgent } from "../proxyAgentCache";
import {
  checkDiskSpace,
  isCanceledError,
  isPausedError,
  startDownload,
  type DownloadHandle,
  type DownloadRequest,
  type ProgressInfo,
} from "./downloader";
import { runLocalAcquire, type LocalAcquireRequest } from "./localAcquire";

/**
 * 下载任务管理服务（M2 Task 5，设计 §8）：单并发顺序队列编排 T4 下载器。
 *
 * - 队列语义：download_tasks 表即队列（status + id 序），一次只跑一个任务；
 *   kick() 取最早的 pending 接棒。完成 / 取消 → 接棒下一个；失败（含运行期
 *   下载中断与 buildRequest / 下载器同步启动失败两种）会计入连续失败计数
 *   （成功清零，取消 / 暂停不计入），未达 MAX_CONSECUTIVE_FAILURES
 *   阈值时照常接棒（单文件 404 / hash 不符不该连坐整批），达到阈值才停队
 *   （视为断网 / 磁盘满一类系统性故障的信号）并记 download.queue_stalled
 *   事件；暂停始终停队（用户主动行为）。停队后只有显式恢复（resume /
 *   resumeQueue）会重新 kick 并把连续失败计数清零，避免"停一次后每次只能
 *   跑一个任务又停"；新入队只排队不复活队列（M5：停摆的解除必须出自用户
 *   明确动作，下载页提示条提供入口）
 * - 分组键是 batch_id（一次 enqueueDownload 一个）而不是模型名：下载发生时
 *   模型配置可能压根还不存在（先下文件、后建配置），归档也因此不再靠时间
 *   窗口凑批次，见 archiveIfBatchDone 的注释
 * - 进度：onProgress 节流写库（progressIntervalMs，默认 500ms），完成时落总量
 * - 重启恢复：recoverOnBoot 把中断的行按 .part 存在性标 paused（可续传）/
 *   pending，并自动 kick 一次让 pending 继续跑（paused 等用户 resume）
 * - 本模块不 import locators（会成环），modelsRoot 默认从 panelConfig 取
 */

/** 入队文件清单条目（T7 向导从量化分组展开传入；size/sha256 来自 HF LFS） */
export interface DownloadFileInput {
  /** 仓库内相对路径（可带子目录）；落盘文件名与之一致 */
  file: string;
  /** 预期总字节数（用于磁盘预检与下载校验）；未知省略 */
  size?: number;
  /** 预期 sha256（HF LFS oid）；未知省略 */
  sha256?: string;
}

/** 入队参数（档案下载与 URL 直链共用；模型配置不再参与） */
export interface EnqueueDownloadArgs {
  files: DownloadFileInput[];
  /** 相对 models 根的落盘目录，**必传**——档案知道自己的目录，URL 直链由用户选 */
  targetDir: string;
  source: "hf" | "url";
  /** source === "hf" 时必填 */
  repo?: string;
  /** source === "url" 时必填 */
  url?: string;
  /** 档案下载时传；URL 直链不传（对应 repo_id 列为 NULL） */
  repoId?: number;
  /** 展示用标签：档案是 repo 名，URL 直链是主机名 */
  label: string;
  /** 与同一次确认里的 local 任务共用一个批次；不传则新开一批（本地权重迁移） */
  batchId?: string;
}

export interface EnqueueDownloadResult {
  taskIds: number[];
  batchId: string;
  /** 目标文件已存在且大小匹配而跳过的文件名（mmproj 跨量化共用的典型场景） */
  skipped: string[];
}

/** 本地获取入队结果：与 {@link EnqueueDownloadResult} 同形状，skipped 的语义也一致 */
export type EnqueueLocalResult = EnqueueDownloadResult;

/** 本地获取入队文件清单条目（本地权重迁移）：与 DownloadFileInput 并列，字段是本地专属的 */
export interface EnqueueLocalItem {
  /** 远端仓库内路径，决定 target_rel 的 basename */
  file: string;
  /** panel 视角绝对路径 */
  sourcePath: string;
  action: "move" | "move-with-refs" | "link" | "copy";
  /** 源与目标是否同一文件系统：只用于这里的磁盘预检决策，不落库——执行时
   *  buildLocalRequest 会用 source_path 相对 modelsRoot 重新判定，不信任这个快照值 */
  sameFs: boolean;
  size: number;
  /** 期望 sha256（远端 LFS oid）。**null 表示手动关联**（规格 §7）：用户已声明
   *  这份文件对应远端目标，跳过内容校验，但大小校验仍然生效——size 必须是
   *  调用方实测出的真实值，不能沿用远端声明的大小，否则手动关联必然因大小
   *  不符而失败 */
  sha256: string | null;
}

export interface EnqueueLocalArgs {
  items: EnqueueLocalItem[];
  /** 相对 models 根的落盘目录 */
  targetDir: string;
  repoId?: number;
  label: string;
  /** 与同一次确认里的 download 任务共用一个批次；不传则新开一批 */
  batchId?: string;
}

/** 任务状态（download_tasks.status 取值；downloading 仅存在于运行中的行） */
export type TaskStatus = "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled";

/** listTasks 视图（API 透传给面板） */
export interface DownloadTaskView {
  id: number;
  /** 同批任务共享，归档与展示的分组单元 */
  batchId: string;
  /** 关联的仓库档案；URL 直链为 null */
  repoId: number | null;
  /** 展示用标签（档案是 repo 名，URL 直链是主机名） */
  label: string;
  kind: "gguf" | "mmproj";
  /** "local" 是本地权重迁移的任务（移动/链接/复制），不是网络下载——UI 要靠它
   *  解释「速度 0 B/s、瞬间完成」的那些行 */
  source: "hf" | "url" | "local";
  file: string;
  targetRel: string;
  shardIndex: number | null;
  shardTotal: number | null;
  expectedSize: number | null;
  sha256: string | null;
  status: TaskStatus;
  downloadedBytes: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** pending 任务在待跑队列中的 0 基序号（按 id 序）；其余状态为 null */
  queuePosition: number | null;
  /** source === "local" 时的手段（move / move-with-refs / link / copy）；其余为 null */
  localAction: "move" | "move-with-refs" | "link" | "copy" | null;
}

export interface DownloadManagerOptions {
  /** 下载器注入点（测试 mock）；缺省用自研 startDownload */
  downloader?: typeof startDownload;
  /** models 根（panel 视角）；缺省取 panel.yaml 的 paths.models.panel */
  modelsRoot?: string;
  /** 进度写库节流间隔（默认 500ms；测试注入 0 全量写） */
  progressIntervalMs?: number;
}

export interface DownloadManager {
  /**
   * 入队一组文件（每文件一行任务）并 kick 队列（停队中只排队不复活，恢复走
   * resumeQueue）；返回任务 id 列表 + 批次 id + 被跳过的文件名。
   *
   * 目标文件已存在且大小匹配的会被跳过而非入队，全部跳过时返回空 taskIds
   * 且不 kick 队列。
   */
  enqueueDownload(args: EnqueueDownloadArgs): Promise<EnqueueDownloadResult>;
  /**
   * 入队一组本地文件获取任务（本地权重迁移）：与 enqueueDownload 共用同一条队列、
   * 同一套「已存在则跳过」判定，执行阶段走 runLocalAcquire 而非网络下载。
   *
   * 与 enqueueDownload 一样返回 skipped：调用方（acquire 路由 → 确认弹层）必须
   * 知道哪些文件根本没入队，否则弹层等不到这些文件的任务推送，「整组是否完成」
   * 的判定对「3 分片已存在 2 片」这类组永远不成立，行卡死在执行中、连关闭都
   * 被执行中守卫拦住。
   */
  enqueueLocal(args: EnqueueLocalArgs): Promise<EnqueueLocalResult>;
  /** 暂停任务（活动任务透传句柄；pending 直接置 paused）。任务不存在抛错 */
  pause(taskId: number): Promise<void>;
  /** 把 paused 行回 pending 并 kick 队列（续传语义由下载器 .part 判定实现） */
  resume(taskId: number): Promise<void>;
  /** 队列级恢复：停队（连续失败达阈值）后由用户手动接续。kick() 入口会把连续失败计数清零 */
  resumeQueue(): void;
  /** 取消任务：活动任务透传句柄（删 .part）+ 队列继续；排队/暂停任务本地删 .part */
  cancel(taskId: number): Promise<void>;
  /**
   * 取消一个批次里所有未完成的任务，返回实际取消的条数（本地权重迁移）。
   *
   * 存在的理由是 acquire 的混合批次要「要么整体成立、要么整体不留痕」：
   * 一次确认分两次入队（download 半 + local 半），第二次因磁盘预检 / 并发占用
   * 抛错时第一次已经真实入队并开跑，客户端只看到整体失败、不落 batchId，
   * 用户重新提交必然撞上自己刚入队的那批（同一落点已有未完成任务 → 409），
   * 除非去下载页手动取消，否则这个档案再也提交不了。
   *
   * 语义就是逐个 cancel：已到终态的行是幂等 no-op（跑完的文件撤不回来，但它
   * 也不再阻塞重新提交）；cancelled 不计入「未完成」，下载页也不展示它。
   */
  cancelBatch(batchId: string): Promise<number>;
  /** 失败/取消的任务原地重试（U25 分片单独重试）：行回 pending（保留 .part 续传），队列接棒 */
  retry(taskId: number): Promise<void>;
  /** 清除已结束的记录（U25）：completed/failed/cancelled 任务行 + 全部历史归档；未完成行与磁盘文件不动 */
  clearFinished(): { tasks: number; history: number };
  /** 面板重启恢复：中断行按 .part 存在性标 paused/pending，自动 kick 一次 */
  recoverOnBoot(): Promise<void>;
  /** 全部任务视图（含进度与队列位置） */
  listTasks(): DownloadTaskView[];
  /** 当前正在下载的任务 id；空闲为 null */
  getQueueHead(): number | null;
}

/** 事件 kind：入队 / 失败 / 全部完成 / 队列因连续失败停住 / 清除历史（对齐 runtime.ts 的事件风格） */
const EVENT_ENQUEUE = "download.enqueue";
const EVENT_FAILED = "download.failed";
const EVENT_COMPLETE = "download.complete";
const EVENT_QUEUE_STALLED = "download.queue_stalled";
const EVENT_CLEAR = "download.clear";

/**
 * 连续失败达到此阈值才停队：单文件 404 / hash 不符不该连坐整批（分片下载时
 * 尤其明显——一片坏不该拖死其余分片），但断网 / 磁盘满等系统性故障会连环
 * 失败，阈值用来区分这两类信号，避免队列在真正故障时空转重试耗光整个批次。
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 中断后可恢复的状态（重启恢复的扫描范围；failed/cancelled 是终态） */
const UNFINISHED_STATUSES = ["pending", "downloading", "paused"] as const;

/** 入队去重与恢复扫描共用的"未完成"状态集（不含 downloading：入队时刻不可能有） */
type TaskRow = {
  id: number;
  batch_id: string;
  repo_id: number | null;
  label: string;
  kind: string;
  source: string;
  repo: string | null;
  url: string | null;
  file: string;
  target_rel: string;
  shard_index: number | null;
  shard_total: number | null;
  expected_size: number | null;
  sha256: string | null;
  status: string;
  downloaded_bytes: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  source_path: string | null;
  local_action: string | null;
};

/** 人类可读字节数（事件消息用；与 downloader.ts 同款实现，保持模块零交叉依赖） */
function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** mmproj 判定与 quant.ts 的分组规则一致：basename 以 mmproj 开头 */
function fileKind(file: string): "gguf" | "mmproj" {
  const name = path.basename(file);
  return name.toLowerCase().startsWith("mmproj") ? "mmproj" : "gguf";
}

/** 相对文件路径合法性：非绝对、无 .. 段（防出 models 根） */
function isSafeRelative(file: string): boolean {
  if (file.startsWith("/") || file.includes("\\")) return false;
  return file.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * targetDir 路径安全校验（B3）：空串单独放行——那是"落 models 根"的合法答案，
 * 不是异常输入。非空串转交 filesApi.assertFolderInsideRoot 复用其四道检查
 * （绝对路径 / .. 段 / 空段 / resolve 后逃逸），该函数的"整体空串"分支对
 * planFileMove 语境成立但对这里不成立，所以在调用前就短路掉，不是在这里
 * 另写一套判定。
 *
 * 统一抛普通 Error 而不是让 FileMoveGuardError 冒泡：manager 现有的校验
 * （如上面的 isSafeRelative）都是"消息含『非法』→ route 映射 400"这套简单
 * 契约，混入另一个错误类只会让 route 层多判一种类型，收益不成比例。
 */
function assertTargetDirSafe(modelsRoot: string, dir: string): void {
  if (dir === "") return;
  try {
    assertFolderInsideRoot(modelsRoot, dir);
  } catch (error) {
    throw new Error(`落盘目录非法: ${errMessage(error)}`);
  }
}

export function createDownloadManager(
  db: Database.Database,
  opts?: DownloadManagerOptions,
): DownloadManager {
  const downloader = opts?.downloader ?? startDownload;
  const modelsRoot = opts?.modelsRoot ?? getPanelConfig().paths.models.panel;
  const progressIntervalMs = opts?.progressIntervalMs ?? 500;

  const stmt = {
    insertTask: db.prepare(`
      INSERT INTO download_tasks(
        batch_id, repo_id, label, kind, source, repo, url, file, target_rel,
        shard_index, shard_total, expected_size, sha256, source_path, local_action,
        status, downloaded_bytes, created_at, updated_at
      ) VALUES (
        @batch_id, @repo_id, @label, @kind, @source, @repo, @url, @file, @target_rel,
        @shard_index, @shard_total, @expected_size, @sha256, @source_path, @local_action,
        'pending', 0, @now, @now
      )
    `),
    getTask: db.prepare("SELECT * FROM download_tasks WHERE id = ?"),
    listTasks: db.prepare("SELECT * FROM download_tasks ORDER BY id DESC"),
    firstPending: db.prepare("SELECT * FROM download_tasks WHERE status = 'pending' ORDER BY id LIMIT 1"),
    unfinishedByTarget: db.prepare(`
      SELECT id FROM download_tasks
      WHERE target_rel = ? AND status IN ('pending', 'downloading', 'paused') LIMIT 1
    `),
    unfinishedIdsByBatch: db.prepare(`
      SELECT id FROM download_tasks
      WHERE batch_id = ? AND status IN ('pending', 'downloading', 'paused') ORDER BY id
    `),
    setStatus: db.prepare("UPDATE download_tasks SET status = @status, updated_at = @now WHERE id = @id"),
    setBytes: db.prepare(
      "UPDATE download_tasks SET downloaded_bytes = @bytes, updated_at = @now WHERE id = @id",
    ),
    setFinished: db.prepare(`
      UPDATE download_tasks
      SET status = @status, downloaded_bytes = @bytes, error = @error, updated_at = @now
      WHERE id = @id
    `),
    // 完成后把下载器边下边算出的实际 sha256 写回（设计 §1.3 缺陷修复）：
    // HF 任务本就期望值等于实际值（LFS oid），URL 直链原先入队时是 NULL，
    // 这一下才第一次拿到真实完整哈希——file_meta 的免费播种正是靠这列。
    setSha256: db.prepare("UPDATE download_tasks SET sha256 = @sha256 WHERE id = @id"),
    recoverable: db.prepare(
      "SELECT * FROM download_tasks WHERE status IN ('pending', 'downloading') ORDER BY id",
    ),
    countUnfinishedByBatch: db.prepare(
      `SELECT COUNT(*) AS c FROM download_tasks
       WHERE batch_id = ? AND status IN ('pending', 'downloading', 'paused')`,
    ),
    tasksByBatch: db.prepare("SELECT * FROM download_tasks WHERE batch_id = ? ORDER BY id"),
    insertHistory: db.prepare(
      `INSERT INTO download_history(
         batch_id, repo_id, label, files, total_bytes, status, finished_at, source_path, local_action
       ) VALUES (
         @batch_id, @repo_id, @label, @files, @total_bytes, @status, @finished_at, @source_path, @local_action
       )`,
    ),
    updateHistoryByBatch: db.prepare(
      `UPDATE download_history
       SET repo_id = @repo_id, label = @label, files = @files, total_bytes = @total_bytes,
           status = @status, finished_at = @finished_at,
           source_path = @source_path, local_action = @local_action
       WHERE batch_id = @batch_id`,
    ),
    insertEvent: db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)"),
    resetForRetry: db.prepare(`
      UPDATE download_tasks SET status = 'pending', error = NULL, updated_at = @now WHERE id = @id
    `),
    deleteFinishedTasks: db.prepare(
      "DELETE FROM download_tasks WHERE status IN ('completed', 'failed', 'cancelled')",
    ),
    deleteAllHistory: db.prepare("DELETE FROM download_history"),
  };

  /** 当前活动任务（单并发不变量的全部内存状态；重启后由 recoverOnBoot 重建） */
  let active: { id: number; handle: DownloadHandle; settled: Promise<void> } | null = null;
  /** 连续失败计数：达到 MAX_CONSECUTIVE_FAILURES 才停队；成功清零，取消 / 暂停不计入 */
  let consecutiveFailures = 0;

  function record(kind: string, message: string): void {
    stmt.insertEvent.run(Date.now(), kind, message);
  }

  function partPaths(task: Pick<TaskRow, "target_rel">): { part: string; meta: string } {
    const target = path.join(modelsRoot, task.target_rel);
    return { part: `${target}.part`, meta: `${target}.part.meta.json` };
  }

  /**
   * 任务起点组装下载请求：hf 源在启动时现读镜像/Token（settings/hf_token 表，
   * Token 可能在面板里刚改过，与 hf/client.ts 的 resolveHfOptions 同语义但用注入
   * 的 db，测试可脱离 getDb 单例）；代理走 getEffectiveProxy（同一个注入 db，D4
   * 双源覆盖语义），ProxyAgent 走 proxyAgentCache 的进程级单例（与 hf/client.ts
   * 共用，按 uri 缓存不重复构造）。
   */
  function buildRequest(task: TaskRow): DownloadRequest {
    const targetPath = path.join(modelsRoot, task.target_rel);
    if (task.source === "url") {
      return { url: task.url!, targetPath, expectedSize: task.expected_size ?? undefined, sha256: task.sha256 ?? undefined };
    }

    let endpoint: string | undefined;
    const mirror = db.prepare("SELECT value FROM settings WHERE key = 'hf_mirror'").get() as
      | { value: string }
      | undefined;
    if (mirror && mirror.value !== "official") endpoint = mirror.value;

    let token: string | undefined = process.env.HF_TOKEN?.trim();
    if (!token) {
      const row = db.prepare("SELECT token FROM hf_token ORDER BY created_at, rowid LIMIT 1").get() as
        | { token: string }
        | undefined;
      token = row?.token;
    }

    const proxy = getEffectiveProxy(db);
    const base = endpoint ?? "https://huggingface.co";
    return {
      url: `${base}/${task.repo}/resolve/main/${task.file}`,
      targetPath,
      expectedSize: task.expected_size ?? undefined,
      sha256: task.sha256 ?? undefined,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      dispatcher: getProxyAgent(proxy),
    };
  }

  /** local 任务的请求组装：source_path 已是 panel 视角绝对路径，直接用 */
  function buildLocalRequest(task: TaskRow): LocalAcquireRequest {
    const targetPath = path.join(modelsRoot, task.target_rel);
    const sourcePath = task.source_path!;
    return {
      sourcePath,
      targetPath,
      // move-with-refs 物理上就是 move；差别只在完成之后要重写配置引用（见完成回调）。
      // 执行器不碰 db，这个区分不该泄漏进去
      action: task.local_action === "move-with-refs" ? "move" : (task.local_action as "move" | "link" | "copy"),
      // 同一文件系统的判定：源落在 models 根内即同盘。根内跨挂载点的极端情况
      // 由执行器的 EXDEV 兜底转成 CROSS_DEVICE，不在这里猜
      sameFs: sourcePath === modelsRoot || sourcePath.startsWith(modelsRoot + path.sep),
      expectedSize: task.expected_size!,
      sha256: task.sha256,
    };
  }

  /** 按 source 选执行器：两者返回同一形状的 DownloadHandle，下游链路无差别 */
  function startTask(task: TaskRow, onProgress: (p: ProgressInfo) => void): DownloadHandle {
    return task.source === "local"
      ? runLocalAcquire(buildLocalRequest(task), onProgress)
      : downloader(buildRequest(task), onProgress);
  }

  /**
   * 批次内所有任务都到终态时归档为 download_history 一条。
   *
   * 旧实现按 model_name 聚合、用 `created_at > 上次归档的 finished_at` 这个
   * 时间窗口凑批次，真机上已经丢过数据：同批入队的 2.74 GB 主文件在历史里
   * 凭空消失，只记下了 0.67 GB 的 mmproj。按 batch_id 聚合后这类漏记在结构上
   * 不可能发生。
   *
   * 同一批次可能到达终态两次——批内有失败行时先归档为 partial，用户重试成功
   * 后批次再次收尾。此时覆盖原来那条而不是并排插第二条：历史列表里一个批次
   * 只该有一行（旧实现在这条路径上是反向的错，重试补回的文件因 created_at
   * 落在窗口外被整条丢弃）。
   *
   * partial 判定看"是否全部为 completed"而不是点名 failed：cancelled 同样
   * 不是"完整完成"，用户取消掉批内一个分片、其余全部下载完成，也该记成
   * partial 而不是 completed——否则历史条目和事件文案都会声称整批齐了，
   * 启动模型时才发现量化少一片。这样写还有个好处：以后再新增终态也自然
   * 落进 partial，不必每加一个状态就回来改一次判定。
   */
  function archiveIfBatchDone(batchId: string): void {
    const unfinished = stmt.countUnfinishedByBatch.get(batchId) as { c: number };
    if (unfinished.c > 0) return;

    const rows = stmt.tasksByBatch.all(batchId) as TaskRow[];
    if (rows.length === 0) return;
    const completed = rows.filter((r) => r.status === "completed");
    if (completed.length === 0) return;

    const files = completed.map((t) => ({
      file: t.file,
      target_rel: t.target_rel,
      bytes: t.downloaded_bytes,
      // local 任务逐条留下「从哪来、用什么手段」；下载任务两项都是 null，
      // 直接省掉不写进 JSON，历史条目的形状对纯下载批次保持原样
      ...(t.source === "local"
        ? { source_path: t.source_path, local_action: t.local_action }
        : {}),
    }));
    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
    const status = rows.some((r) => r.status !== "completed") ? "partial" : "completed";
    // v17 的 source_path / local_action 两列：批内有 local 任务时标出「这批不是
    // 下来的、是挪来的」，纯下载批次保持 NULL。历史一行 = 一个批次，装不下逐
    // 文件的差异，所以这两列是**批级摘要**（动作去重拼接、源路径取批内第一条
    // local 任务的），逐文件的完整记录在上面的 files JSON 里
    const localTasks = completed.filter((t) => t.source === "local");
    const localActions = [
      ...new Set(localTasks.map((t) => t.local_action).filter((a): a is string => a !== null)),
    ];
    const payload = {
      batch_id: batchId,
      repo_id: rows[0].repo_id,
      label: rows[0].label,
      files: JSON.stringify(files),
      total_bytes: totalBytes,
      status,
      finished_at: Date.now(),
      source_path: localTasks[0]?.source_path ?? null,
      local_action: localActions.length > 0 ? localActions.join(",") : null,
    };
    if (stmt.updateHistoryByBatch.run(payload).changes === 0) {
      stmt.insertHistory.run(payload);
    }
    record(
      EVENT_COMPLETE,
      status === "partial"
        ? `${rows[0].label} 下载部分完成（${completed.length}/${rows.length} 个文件，共 ${formatBytes(totalBytes)}，其余 ${rows.length - completed.length} 个未完成）`
        : `${rows[0].label} 下载完成（${completed.length} 个文件，共 ${formatBytes(totalBytes)}）`,
    );
  }

  /**
   * 队列驱动：取最早的 pending 开跑。从取行、置 downloading 到建句柄全程同步
   * （better-sqlite3 同步 API + JS 单线程），kick 重入与并发 enqueue 不会双开。
   * 完成/取消/未达连续失败阈值的失败 → 接棒；暂停/达到阈值的失败 → 停队
   * （advance=false），等 resume / resumeQueue 等显式恢复 kick。失败分两条接棒路径：运行期
   * handle.result reject 走下面 finish() 里的 advance；buildRequest /
   * downloader 同步抛错（此时 active 还没赋值，没有 finish() 可用）走 catch
   * 分支里的直接递归调 kick()，两条路径共享同一个 consecutiveFailures 计数。
   */
  function kick(): void {
    if (active !== null) return;
    // 停队后能重新进到这里，只可能是 resume / resumeQueue 等显式恢复触发
    // （内部接棒链从不会在计数达阈值时调用 kick，新入队在停队时不 kick）；
    // 此时视为"复活"，把计数清零，否则停队一次之后每次只能跑一个任务又停。
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
    const next = stmt.firstPending.get() as TaskRow | undefined;
    if (!next) return;

    let handle: DownloadHandle;
    try {
      stmt.setStatus.run({ id: next.id, status: "downloading", now: Date.now() });

      // 进度节流写库：首个回调立即落一次，其后间隔 progressIntervalMs
      let lastWrite = 0;
      const onProgress = (p: ProgressInfo): void => {
        const now = Date.now();
        if (now - lastWrite < progressIntervalMs) return;
        lastWrite = now;
        stmt.setBytes.run({ id: next.id, bytes: p.downloaded, now });
      };

      handle = startTask(next, onProgress);
    } catch (error) {
      // 请求组装 / 下载器同步启动失败：与运行期失败（handle.result reject）同语义
      // 计入连续失败计数。这里 active 还没赋值、finish() 也还没定义，没法复用
      // 运行期那条 finish() 链路，未达阈值时改为直接递归调 kick() 接棒——
      // next 这一行已经在上面 setFinished 标成 failed（终态），下一轮
      // stmt.firstPending 必然取到别的行，不会重复处理同一任务；递归深度又被
      // consecutiveFailures < MAX_CONSECUTIVE_FAILURES 卡死上限（至多连续
      // 递归 MAX_CONSECUTIVE_FAILURES 层），既不会无限递归/栈溢出，也不会
      // 一次性把所有 pending 刷成 failed。
      const message = errMessage(error);
      stmt.setFinished.run({ id: next.id, status: "failed", bytes: 0, error: message, now: Date.now() });
      record(EVENT_FAILED, `${next.label} 下载失败: ${next.file}: ${message}`);
      consecutiveFailures++;
      if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        kick(); // 未达阈值：照常接棒下一个
      } else {
        record(
          EVENT_QUEUE_STALLED,
          `${next.label} 连续 ${consecutiveFailures} 次下载失败，队列已停止，可在下载页点「继续队列」恢复`,
        );
      }
      return;
    }

    let resolveSettled!: () => void;
    const settled = new Promise<void>((r) => {
      resolveSettled = r;
    });
    active = { id: next.id, handle, settled };

    let advance = false;
    const finish = (): void => {
      active = null;
      resolveSettled();
      if (advance) kick();
    };

    handle.result.then(
      (result) => {
        stmt.setFinished.run({
          id: next.id,
          status: "completed",
          bytes: result.bytes,
          error: null,
          now: Date.now(),
        });
        if (result.sha256 !== undefined) {
          stmt.setSha256.run({ id: next.id, sha256: result.sha256 });
        }
        archiveIfBatchDone(next.batch_id);
        consecutiveFailures = 0; // 成功清零：连续失败计数只跟踪"连续"失败
        advance = true; // 接棒下一个
        finish();
      },
      (error) => {
        const now = Date.now();
        if (isPausedError(error)) {
          // 保留队列位：行 paused、downloaded_bytes 维持最近一次节流值，队列停住
          // （用户主动暂停，不是故障信号，不计入连续失败计数）
          stmt.setStatus.run({ id: next.id, status: "paused", now });
        } else if (isCanceledError(error)) {
          stmt.setFinished.run({ id: next.id, status: "cancelled", bytes: 0, error: null, now });
          advance = true; // 取消让位，接棒下一个（用户主动行为，不计入连续失败计数）
        } else {
          const message = errMessage(error);
          stmt.setFinished.run({ id: next.id, status: "failed", bytes: 0, error: message, now });
          record(EVENT_FAILED, `${next.label} 下载失败: ${next.file}: ${message}`);
          consecutiveFailures++;
          if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
            advance = true; // 未达阈值：单文件失败不该连坐整批，照常接棒
          } else {
            record(
              EVENT_QUEUE_STALLED,
              `${next.label} 连续 ${consecutiveFailures} 次下载失败，队列已停止，可在下载页点「继续队列」恢复`,
            );
          }
        }
        finish();
      },
    );
  }

  /**
   * 文件名与落盘目录的安全校验：download 与 local 两个入队入口共用同一套规则
   * （非法段 / 逃逸 models 根），不各自实现一遍出现细微不一致。
   */
  function assertEnqueueFilesSafe(files: { file: string }[], targetDir: string): void {
    if (files.length === 0) throw new Error("文件列表为空: 至少一个文件");
    for (const f of files) {
      if (!isSafeRelative(f.file)) throw new Error(`文件路径非法: ${f.file}`);
    }
    assertTargetDirSafe(modelsRoot, targetDir);
  }

  /**
   * 已存在且大小匹配 → 跳过。这是 mmproj 跨量化共用的关键：同档案下第二个
   * 量化时 mmproj 的目标路径与首次相同，文件已在就不该再下一遍（下载）/ 再挪一遍
   * （本地获取）。大小不符说明是残缺文件，照常覆盖；expected_size 未知时保守处理。
   * download 与 local 共用同一份判定。
   */
  function partitionExistingTargets<T extends { file: string; size?: number }>(
    targetRelOf: (file: string) => string,
    files: T[],
  ): { skipped: string[]; pending: T[] } {
    const skipped: string[] = [];
    const pending: T[] = [];
    for (const f of files) {
      const abs = path.join(modelsRoot, targetRelOf(f.file));
      if (f.size !== undefined && existsSync(abs) && statSync(abs).size === f.size) {
        skipped.push(f.file);
      } else {
        pending.push(f);
      }
    }
    return { skipped, pending };
  }

  /** 并发占用校验：同一落点已有未完成任务时拒绝入队，download 与 local 共用 */
  function assertNoUnfinishedAtTargets(targetRels: string[]): void {
    for (const targetRel of targetRels) {
      if (stmt.unfinishedByTarget.get(targetRel) !== undefined) {
        throw new Error(`已有未完成的下载任务: ${targetRel}`);
      }
    }
  }

  async function enqueueDownload(args: EnqueueDownloadArgs): Promise<EnqueueDownloadResult> {
    const { files, targetDir, source, repo, url, repoId, label, batchId: providedBatchId } = args;
    assertEnqueueFilesSafe(files, targetDir);
    // source 与 repo/url 的搭配在这里守，而不是留给三个调用方各自的 zod schema：
    // 旧实现靠 model.download 这个可辨识联合天然兜住，改成散参数后就没人管了，
    // 漏传 repo 会静默拼出 .../null/resolve/main/... 一路下到 404 才发现。
    if (source === "hf" && (repo === undefined || repo === "")) {
      throw new Error("source 为 hf 时必须提供 repo");
    }
    if (source === "url" && (url === undefined || url === "")) {
      throw new Error("source 为 url 时必须提供 url");
    }

    const targetRelOf = (file: string): string =>
      targetDir === "" ? file : `${targetDir}/${file}`;
    const { skipped, pending } = partitionExistingTargets(targetRelOf, files);

    const batchId = providedBatchId ?? randomUUID();
    if (pending.length === 0) return { taskIds: [], batchId, skipped };

    // 磁盘预检：组总大小已知时对照 models 根所在分区剩余空间，不足直接拒绝（不入队）
    const knownTotal = pending.reduce((sum, f) => sum + (f.size ?? 0), 0);
    if (knownTotal > 0) {
      await mkdir(modelsRoot, { recursive: true });
      await checkDiskSpace(modelsRoot, knownTotal, getModelsHost());
    }

    assertNoUnfinishedAtTargets(pending.map((f) => targetRelOf(f.file)));

    const now = Date.now();
    const ids: number[] = [];
    for (const f of pending) {
      const shard = shardInfo(f.file);
      const info = stmt.insertTask.run({
        batch_id: batchId,
        repo_id: repoId ?? null,
        label,
        kind: fileKind(f.file),
        source,
        repo: source === "hf" ? (repo ?? null) : null,
        url: source === "url" ? (url ?? null) : null,
        file: f.file,
        target_rel: targetRelOf(f.file),
        shard_index: shard?.index ?? null,
        shard_total: shard?.total ?? null,
        expected_size: f.size ?? null,
        sha256: f.sha256 ?? null,
        source_path: null,
        local_action: null,
        now,
      });
      ids.push(Number(info.lastInsertRowid));
    }
    record(
      EVENT_ENQUEUE,
      `入队下载 ${label}（${ids.length} 个任务` +
        (skipped.length > 0 ? `，跳过 ${skipped.length} 个已存在文件` : "") +
        "）",
    );
    // 停队中只入队不 kick：恢复必须走显式 resumeQueue（M5），停摆不因新任务无意解除
    if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) kick();
    return { taskIds: ids, batchId, skipped };
  }

  /**
   * 入队一组本地文件获取任务：路径校验、「已存在则跳过」判定与并发占用检查
   * 全部复用 enqueueDownload 的同一份逻辑（见上面三个共用私有函数），只有
   * 磁盘预检与落库字段是 local 专属的——磁盘预检不能照搬下载那套「按总字节数」
   * 检查：link 不占盘、同盘 move 靠 rename 不占盘，只有 copy（含跨盘 move，
   * 会退化成复制后删源）真的要写一份新文件，因此只按需要复制的条目求和。
   */
  async function enqueueLocal(args: EnqueueLocalArgs): Promise<EnqueueLocalResult> {
    const { items, targetDir, repoId, label, batchId: providedBatchId } = args;
    assertEnqueueFilesSafe(items, targetDir);

    const targetRelOf = (file: string): string =>
      targetDir === "" ? file : `${targetDir}/${file}`;
    const { skipped, pending } = partitionExistingTargets(targetRelOf, items);

    const batchId = providedBatchId ?? randomUUID();
    if (pending.length === 0) return { taskIds: [], batchId, skipped };

    const copyTotal = pending
      .filter(
        (it) =>
          it.action === "copy" ||
          ((it.action === "move" || it.action === "move-with-refs") && !it.sameFs),
      )
      .reduce((sum, it) => sum + it.size, 0);
    if (copyTotal > 0) {
      await mkdir(modelsRoot, { recursive: true });
      await checkDiskSpace(modelsRoot, copyTotal, getModelsHost());
    }

    assertNoUnfinishedAtTargets(pending.map((it) => targetRelOf(it.file)));

    const now = Date.now();
    const ids: number[] = [];
    for (const it of pending) {
      const shard = shardInfo(it.file);
      const info = stmt.insertTask.run({
        batch_id: batchId,
        repo_id: repoId ?? null,
        label,
        kind: fileKind(it.file),
        source: "local",
        repo: null,
        url: null,
        file: it.file,
        target_rel: targetRelOf(it.file),
        shard_index: shard?.index ?? null,
        shard_total: shard?.total ?? null,
        expected_size: it.size,
        sha256: it.sha256,
        source_path: it.sourcePath,
        local_action: it.action,
        now,
      });
      ids.push(Number(info.lastInsertRowid));
    }
    record(
      EVENT_ENQUEUE,
      `入队本地获取 ${label}（${ids.length} 个任务` +
        (skipped.length > 0 ? `，跳过 ${skipped.length} 个已存在文件` : "") +
        "）",
    );
    if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) kick();
    return { taskIds: ids, batchId, skipped };
  }

  async function pause(taskId: number): Promise<void> {
    const task = stmt.getTask.get(taskId) as TaskRow | undefined;
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const current = active;
    if (current?.id === taskId) {
      current.handle.pause();
      await current.settled;
    } else if (task.status === "pending") {
      stmt.setStatus.run({ id: taskId, status: "paused", now: Date.now() });
    }
    // 已 paused / 终态：幂等 no-op
  }

  async function resume(taskId: number): Promise<void> {
    const task = stmt.getTask.get(taskId) as TaskRow | undefined;
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== "paused") return;
    stmt.setStatus.run({ id: taskId, status: "pending", now: Date.now() });
    kick();
  }

  function resumeQueue(): void {
    kick();
  }

  async function cancel(taskId: number): Promise<void> {
    const task = stmt.getTask.get(taskId) as TaskRow | undefined;
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const current = active;
    if (current?.id === taskId) {
      // 下载器负责删 .part + reject → 行 cancelled → finish 里接棒下一个。
      // 先捕获引用：await 期间 active 可能已被 finish 置空并 kick 出新任务。
      await current.handle.cancel();
      await current.settled;
      return;
    }
    if ((UNFINISHED_STATUSES as readonly string[]).includes(task.status)) {
      const { part, meta } = partPaths(task);
      await Promise.allSettled([unlink(part), unlink(meta)]);
      stmt.setFinished.run({ id: taskId, status: "cancelled", bytes: 0, error: null, now: Date.now() });
    }
    // 终态：幂等 no-op
  }

  /**
   * 撤回一个批次里所有未完成的任务（acquire 混合批次的回滚，见接口 JSDoc）。
   *
   * 逐个走 cancel 而不是直接 UPDATE：活动任务必须透传句柄才能真正中断读写并
   * 清掉 .part 半成品，一条 SQL 改不动内存里那个句柄。单条撤单失败一律吞掉
   * ——调用方此刻要回给用户的是入队失败的原因，不是撤单的次生错误。
   */
  async function cancelBatch(batchId: string): Promise<number> {
    const ids = (stmt.unfinishedIdsByBatch.all(batchId) as { id: number }[]).map((r) => r.id);
    let cancelled = 0;
    for (const id of ids) {
      try {
        await cancel(id);
        cancelled += 1;
      } catch {
        // 忽略：撤单尽力而为
      }
    }
    return cancelled;
  }

  /**
   * 失败/取消的任务原地重试（U25）：行标回 pending、清错误标记（downloaded_bytes
   * 维持原值，.part 若在由下载器续传语义接管）。completed 行不可重试（文件已在，
   * 想再下走重新入队）；paused 行走 resume。停队中只排队不复活（与入队语义一致，
   * 恢复必须走显式 resumeQueue）。
   */
  async function retry(taskId: number): Promise<void> {
    const task = stmt.getTask.get(taskId) as TaskRow | undefined;
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new Error(`仅失败或已取消的任务可重试（当前: ${task.status}）: ${taskId}`);
    }
    stmt.resetForRetry.run({ id: taskId, now: Date.now() });
    if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) kick();
  }

  /**
   * 清除已结束的记录（U25）：completed/failed/cancelled 任务行 + 全部历史归档。
   * 未完成行（pending/downloading/paused）与磁盘文件一律不动；跨越这次清除的
   * 批次后续归档时只看得到未被删的行，归档内容随之缩水——这是清除操作本身的
   * 语义（用户要的就是"抹掉已结束的记录"），不是漏记。
   */
  function clearFinished(): { tasks: number; history: number } {
    const tasks = Number(stmt.deleteFinishedTasks.run().changes);
    const history = Number(stmt.deleteAllHistory.run().changes);
    if (tasks + history > 0) {
      record(EVENT_CLEAR, `清除下载记录（${tasks} 个任务，${history} 条历史）`);
    }
    return { tasks, history };
  }

  async function recoverOnBoot(): Promise<void> {
    const rows = stmt.recoverable.all() as TaskRow[];
    for (const row of rows) {
      const { part } = partPaths(row);
      let hasPart = false;
      try {
        hasPart = (await stat(part)).size > 0;
      } catch {
        hasPart = false;
      }
      // .part 在 → paused（可续传，等用户 resume）；不在 → pending（kick 后从头下）
      const status: TaskStatus = hasPart ? "paused" : "pending";
      if (row.status !== status) {
        stmt.setStatus.run({ id: row.id, status, now: Date.now() });
      }
    }
    kick(); // 自动接棒一次：pending 继续跑，paused 留给用户
  }

  function listTasks(): DownloadTaskView[] {
    const rows = stmt.listTasks.all() as TaskRow[];
    // pending 按 id 升序编号（等待顺序），视图按 id 倒序展示
    const pendingIds = (
      db.prepare("SELECT id FROM download_tasks WHERE status = 'pending' ORDER BY id").all() as {
        id: number;
      }[]
    ).map((r) => r.id);
    const position = new Map(pendingIds.map((id, i) => [id, i]));
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      repoId: row.repo_id,
      label: row.label,
      kind: row.kind as "gguf" | "mmproj",
      source: row.source as DownloadTaskView["source"],
      file: row.file,
      targetRel: row.target_rel,
      shardIndex: row.shard_index,
      shardTotal: row.shard_total,
      expectedSize: row.expected_size,
      sha256: row.sha256,
      status: row.status as TaskStatus,
      downloadedBytes: row.downloaded_bytes,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      queuePosition: position.has(row.id) ? position.get(row.id)! : null,
      localAction: row.local_action as DownloadTaskView["localAction"],
    }));
  }

  function getQueueHead(): number | null {
    return active?.id ?? null;
  }

  return {
    enqueueDownload,
    enqueueLocal,
    pause,
    resume,
    resumeQueue,
    cancel,
    cancelBatch,
    retry,
    clearFinished,
    recoverOnBoot,
    listTasks,
    getQueueHead,
  };
}
