import type Database from "better-sqlite3";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { shardInfo } from "../../core/files";
import type { ModelConfig } from "../../core/schemas";
import { getPanelConfig } from "../panelConfig";
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
import type { StoredModel } from "../repo/models";

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

/** 任务状态（download_tasks.status 取值；downloading 仅存在于运行中的行） */
export type TaskStatus = "pending" | "downloading" | "paused" | "completed" | "failed" | "cancelled";

/** listTasks 视图（API 透传给面板） */
export interface DownloadTaskView {
  id: number;
  model: string;
  kind: "gguf" | "mmproj";
  source: "hf" | "url";
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
  /** U15 自动启动意图标记（组内行同值；完成钩子消费） */
  autoStart: boolean;
}

export interface DownloadManagerOptions {
  /** 下载器注入点（测试 mock）；缺省用自研 startDownload */
  downloader?: typeof startDownload;
  /** models 根（panel 视角）；缺省取 panel.yaml 的 paths.models.panel */
  modelsRoot?: string;
  /** 进度写库节流间隔（默认 500ms；测试注入 0 全量写） */
  progressIntervalMs?: number;
  /**
   * 下载全部完成后的自动启动回调（UX P1 U15，locators 注入避免本模块
   * import locators 成环）。触发条件：模型组窗口内有 auto_start 完成行且
   * 无 failed/cancelled 行。防切换守卫（不顶掉运行中模型）由回调实现方负责。
   */
  onAutoStart?: (modelName: string) => Promise<void>;
}

export interface DownloadManager {
  /** 入队一组文件（每文件一行任务）并 kick 队列（停队中只排队不复活，恢复走 resumeQueue）；返回任务 id 列表 */
  enqueueModelDownload(
    model: ModelConfig | StoredModel,
    files: DownloadFileInput[],
    targetNamespace?: string,
    opts?: { autoStart?: boolean },
  ): Promise<number[]>;
  /** 暂停任务（活动任务透传句柄；pending 直接置 paused）。任务不存在抛错 */
  pause(taskId: number): Promise<void>;
  /** 把 paused 行回 pending 并 kick 队列（续传语义由下载器 .part 判定实现） */
  resume(taskId: number): Promise<void>;
  /** 队列级恢复：停队（连续失败达阈值）后由用户手动接续。kick() 入口会把连续失败计数清零 */
  resumeQueue(): void;
  /** 取消任务：活动任务透传句柄（删 .part）+ 队列继续；排队/暂停任务本地删 .part */
  cancel(taskId: number): Promise<void>;
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
  model_name: string;
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
  auto_start: number;
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

export function createDownloadManager(
  db: Database.Database,
  opts?: DownloadManagerOptions,
): DownloadManager {
  const downloader = opts?.downloader ?? startDownload;
  const modelsRoot = opts?.modelsRoot ?? getPanelConfig().paths.models.panel;
  const progressIntervalMs = opts?.progressIntervalMs ?? 500;
  const onAutoStart = opts?.onAutoStart;

  const stmt = {
    insertTask: db.prepare(`
      INSERT INTO download_tasks(
        model_name, kind, source, repo, url, file, target_rel, shard_index, shard_total,
        expected_size, sha256, status, downloaded_bytes, auto_start, created_at, updated_at
      ) VALUES (
        @model_name, @kind, @source, @repo, @url, @file, @target_rel, @shard_index, @shard_total,
        @expected_size, @sha256, 'pending', 0, @auto_start, @now, @now
      )
    `),
    getTask: db.prepare("SELECT * FROM download_tasks WHERE id = ?"),
    listTasks: db.prepare("SELECT * FROM download_tasks ORDER BY id DESC"),
    firstPending: db.prepare("SELECT * FROM download_tasks WHERE status = 'pending' ORDER BY id LIMIT 1"),
    unfinishedByTarget: db.prepare(`
      SELECT id FROM download_tasks
      WHERE target_rel = ? AND status IN ('pending', 'downloading', 'paused') LIMIT 1
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
    recoverable: db.prepare(
      "SELECT * FROM download_tasks WHERE status IN ('pending', 'downloading') ORDER BY id",
    ),
    countUnfinishedByModel: db.prepare(`
      SELECT COUNT(*) AS c FROM download_tasks
      WHERE model_name = ? AND status IN ('pending', 'downloading', 'paused')
    `),
    lastHistoryAt: db.prepare(
      "SELECT finished_at FROM download_history WHERE model_name = ? ORDER BY id DESC LIMIT 1",
    ),
    completedSince: db.prepare(`
      SELECT * FROM download_tasks
      WHERE model_name = ? AND status = 'completed' AND created_at > ? ORDER BY id
    `),
    /** U15：窗口内是否有 auto_start 意图的完成行 / 是否有失败行（触发与阻断判定） */
    autoStartSince: db.prepare(`
      SELECT COUNT(*) AS c FROM download_tasks
      WHERE model_name = ? AND auto_start = 1 AND status = 'completed' AND created_at > ?
    `),
    failedSince: db.prepare(`
      SELECT COUNT(*) AS c FROM download_tasks
      WHERE model_name = ? AND status IN ('failed', 'cancelled') AND created_at > ?
    `),
    insertHistory: db.prepare(`
      INSERT INTO download_history(model_name, files, total_bytes, status, finished_at)
      VALUES (?, ?, ?, 'completed', ?)
    `),
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
   * 的 db，测试可脱离 getDb 单例）；代理来自 panel.yaml，ProxyAgent 走
   * proxyAgentCache 的进程级单例（与 hf/client.ts 共用，按 uri 缓存不重复构造）。
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

    const proxy = getPanelConfig().proxy;
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

  /**
   * 全部完成归档：某模型的最后一个任务完成且无未完成行（pending/downloading/
   * paused）时，把该模型自上次归档以来的 completed 行打包进 download_history 一条
   * （failed/cancelled 不入档也不阻塞——失败明细留在任务行与事件里）。
   *
   * justCompletedWithIntent：本次刚完成的行自身带 auto_start 标记（U15）。
   * 触发判定 = 窗口内有意图完成行或本行带意图，且窗口内无 failed/cancelled 行
   * ——失败分片经 U25 原地重试成功后，重试行已不在 created_at 窗口内，靠本参数
   * 补上这条路径。
   */
  function archiveIfModelDone(modelName: string, justCompletedWithIntent = false): void {
    const unfinished = stmt.countUnfinishedByModel.get(modelName) as { c: number };
    if (unfinished.c > 0) return;
    const last = stmt.lastHistoryAt.get(modelName) as { finished_at: number } | undefined;
    const cutoff = last?.finished_at ?? 0;
    const completed = stmt.completedSince.all(modelName, cutoff) as TaskRow[];
    if (completed.length > 0) {
      const files = completed.map((t) => ({
        file: t.file,
        target_rel: t.target_rel,
        bytes: t.downloaded_bytes,
      }));
      const totalBytes = completed.reduce((sum, t) => sum + t.downloaded_bytes, 0);
      stmt.insertHistory.run(modelName, JSON.stringify(files), totalBytes, Date.now());
      record(
        EVENT_COMPLETE,
        `模型 ${modelName} 下载完成（${completed.length} 个文件，共 ${formatBytes(totalBytes)}）`,
      );
    }

    // U15 自动启动：文件不完整（窗口内有失败/取消行）时启动必败，不如把选择权
    // 留给用户处理完失败分片。回调异步执行，不阻塞归档与队列接棒；启动失败由
    // runtime 的 model.start_failed 事件承接。
    if (!onAutoStart) return;
    const wanted = justCompletedWithIntent
      ? true
      : (stmt.autoStartSince.get(modelName, cutoff) as { c: number }).c > 0;
    const blocked = (stmt.failedSince.get(modelName, cutoff) as { c: number }).c > 0;
    if (wanted && !blocked) {
      onAutoStart(modelName).catch((error) => {
        console.error(`模型 ${modelName} 自动启动失败:`, error);
      });
    }
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
      const req = buildRequest(next);
      stmt.setStatus.run({ id: next.id, status: "downloading", now: Date.now() });

      // 进度节流写库：首个回调立即落一次，其后间隔 progressIntervalMs
      let lastWrite = 0;
      const onProgress = (p: ProgressInfo): void => {
        const now = Date.now();
        if (now - lastWrite < progressIntervalMs) return;
        lastWrite = now;
        stmt.setBytes.run({ id: next.id, bytes: p.downloaded, now });
      };

      handle = downloader(req, onProgress);
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
      record(EVENT_FAILED, `模型 ${next.model_name} 下载失败: ${next.file}: ${message}`);
      consecutiveFailures++;
      if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        kick(); // 未达阈值：照常接棒下一个
      } else {
        record(
          EVENT_QUEUE_STALLED,
          `模型 ${next.model_name} 连续 ${consecutiveFailures} 次下载失败，队列已停止，可在下载页点「继续队列」恢复`,
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
        archiveIfModelDone(next.model_name, next.auto_start === 1);
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
          record(EVENT_FAILED, `模型 ${next.model_name} 下载失败: ${next.file}: ${message}`);
          consecutiveFailures++;
          if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
            advance = true; // 未达阈值：单文件失败不该连坐整批，照常接棒
          } else {
            record(
              EVENT_QUEUE_STALLED,
              `模型 ${next.model_name} 连续 ${consecutiveFailures} 次下载失败，队列已停止，可在下载页点「继续队列」恢复`,
            );
          }
        }
        finish();
      },
    );
  }

  async function enqueueModelDownload(
    model: ModelConfig | StoredModel,
    files: DownloadFileInput[],
    targetNamespace?: string,
    opts?: { autoStart?: boolean },
  ): Promise<number[]> {
    if (!model.download) throw new Error(`模型未配置下载源: ${model.name}`);
    if (files.length === 0) throw new Error("文件列表为空: 至少一个文件");
    for (const f of files) {
      if (!isSafeRelative(f.file)) throw new Error(`文件路径非法: ${f.file}`);
    }
    const dl = model.download;

    // 磁盘预检：组总大小已知时对照 models 根所在分区剩余空间，不足直接拒绝（不入队）
    const knownTotal = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    if (knownTotal > 0) {
      await mkdir(modelsRoot, { recursive: true });
      await checkDiskSpace(modelsRoot, knownTotal, getPanelConfig().paths.models.host);
    }

    // 检查 + 入队同一同步块（JS 单线程保证原子，不会被并发 enqueue 穿透）
    const namespace = targetNamespace ?? model.namespace;
    const now = Date.now();
    const ids: number[] = [];
    for (const f of files) {
      const targetRel = `${namespace}/${f.file}`;
      if (stmt.unfinishedByTarget.get(targetRel) !== undefined) {
        throw new Error(`已有未完成的下载任务: ${targetRel}`);
      }
    }
    for (const f of files) {
      const shard = shardInfo(f.file);
      const info = stmt.insertTask.run({
        model_name: model.name,
        kind: fileKind(f.file),
        source: dl.source,
        repo: dl.source === "hf" ? dl.repo : null,
        url: dl.source === "url" ? dl.url : null,
        file: f.file,
        target_rel: `${namespace}/${f.file}`,
        shard_index: shard?.index ?? null,
        shard_total: shard?.total ?? null,
        expected_size: f.size ?? null,
        sha256: f.sha256 ?? null,
        auto_start: opts?.autoStart ? 1 : 0,
        now,
      });
      ids.push(Number(info.lastInsertRowid));
    }
    record(EVENT_ENQUEUE, `入队下载模型 ${model.name}（${files.length} 个任务）`);
    // 停队中只入队不 kick：恢复必须走显式 resumeQueue（M5），停摆不因新任务无意解除
    if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) kick();
    return ids;
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
   * 未完成行（pending/downloading/paused）与磁盘文件一律不动；正在下载的模型
   * 组后续归档时 completedSince 只会找到未删的行，与空历史截止位语义自洽。
   */
  function clearFinished(): { tasks: number; history: number } {
    const tasks = Number(stmt.deleteFinishedTasks.run().changes);
    const history = Number(stmt.deleteAllHistory.run().changes);
    if (tasks + history > 0) {
      record(EVENT_CLEAR, `清除下载记录（${tasks} 个任务，${history} 条历史）`);
    }
    return { tasks, history };
  }

  async function recoverOnBoot(): Promise<void> {    const rows = stmt.recoverable.all() as TaskRow[];
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
      model: row.model_name,
      kind: row.kind as "gguf" | "mmproj",
      source: row.source as "hf" | "url",
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
      autoStart: row.auto_start === 1,
    }));
  }

  function getQueueHead(): number | null {
    return active?.id ?? null;
  }

  return {
    enqueueModelDownload,
    pause,
    resume,
    resumeQueue,
    cancel,
    retry,
    clearFinished,
    recoverOnBoot,
    listTasks,
    getQueueHead,
  };
}
