import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { PART_SUFFIX } from "@/lib/download-part";
import { DownloadError, type DownloadHandle, type DownloadResult, type ProgressInfo } from "./downloader";

/**
 * 本地获取执行器（设计 §7.2）
 *
 * 与 startDownload 返回同一形状的 DownloadHandle，因此 manager.kick() 的
 * handle.result.then(...) 整条链路（完成落库 / 暂停保位 / 取消让位 / 失败计数 /
 * 批次归档）一行都不用改——这是本设计把风险控制住的关键。
 *
 * 两阶段：校验（流式读源算 sha256）→ 执行（rename / link / copy，任务 7/8 补齐）。
 * 进度单调递增：总工作量 = 校验一遍 + （需要复制时）再写一遍，见 totalWorkOf。
 *
 * 不支持续传：下载器的续传靠 .part.meta.json 里的 url/etag 判定同源，本地复制
 * 没有这两样可比对，硬做等于凭路径猜。pause 与 cancel 都是中止并删 .part，
 * 差别只在抛哪种错误；恢复后从头重跑，本地盘重来的成本远低于网络下载。
 *
 * 错误判别复用 downloader.ts 的 DownloadError（code: "PAUSED"/"CANCELED"）而不是
 * 另起一套错误类：manager.ts 用 isPausedError/isCanceledError 判定 handle.result
 * 的 reject 原因，两套判别标准必须同源，否则本地取消会被当成下载失败计入连续失败计数。
 */

export interface LocalAcquireRequest {
  /** panel 视角绝对路径 */
  sourcePath: string;
  /** panel 视角绝对路径（最终落点） */
  targetPath: string;
  action: "move" | "link" | "copy";
  /** 源与目标是否同一文件系统。false 时 move 降级为「复制后删源」、link 直接失败 */
  sameFs: boolean;
  expectedSize: number;
  /** 期望 sha256（远端 LFS oid）。acquire 路由保证非空——无 oid 的文件根本不给挪 */
  sha256: string;
}

/** 需要复制时总工作量翻倍（校验读一遍 + 复制写一遍），保证进度不倒退 */
function totalWorkOf(req: LocalAcquireRequest): number {
  const needsCopy = req.action === "copy" || (req.action === "move" && !req.sameFs);
  return needsCopy ? req.expectedSize * 2 : req.expectedSize;
}

/** EXDEV 转成有码错误：裸 EXDEV 会冒泡成没有错误码的 500，用户看不懂 */
function isCrossDevice(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EXDEV";
}

/**
 * 执行阶段：move（同盘用 rename）与 link（硬链接）已落地——两者都是同文件系统内的
 * 元数据操作，毫秒级完成，不需要额外的进度上报。copy 与跨盘 move（复制后删源）
 * 仍是显式占位：流式复制留给任务 8，在那之前宁可显式失败，也不悄悄冒充执行成功。
 */
async function performAction(
  req: LocalAcquireRequest,
  _read: number,
  _total: number,
  _started: number,
  _onProgress: ((p: ProgressInfo) => void) | undefined,
  _controller: AbortController,
  _isPausing: () => boolean,
): Promise<void> {
  // 档案目录本身一定在（调用方保证），但落点可能带子目录（如按量化分组的子路径）
  await mkdir(path.dirname(req.targetPath), { recursive: true });

  if (req.action === "link") {
    if (!req.sameFs) throw new Error("CROSS_DEVICE：源与目标不在同一文件系统，无法硬链接");
    try {
      await link(req.sourcePath, req.targetPath);
    } catch (error) {
      if (isCrossDevice(error)) throw new Error("CROSS_DEVICE：源与目标不在同一文件系统，无法硬链接");
      throw error;
    }
    return;
  }

  if (req.action === "move" && req.sameFs) {
    try {
      await rename(req.sourcePath, req.targetPath);
    } catch (error) {
      if (isCrossDevice(error)) {
        // sameFs 判定失误的兜底：调用方按「是否在 models 根内」推断，
        // 根内跨挂载点（用户把子目录单独挂了别的盘）确实可能骗过它
        throw new Error("CROSS_DEVICE：源与目标不在同一文件系统，请改用复制");
      }
      throw error;
    }
    return;
  }

  // copy，以及跨盘的 move（复制后删源）——任务 8 实现
  throw new Error("本地执行阶段尚未实现，见任务 8（copy / 跨盘 move）");
}

export function runLocalAcquire(
  req: LocalAcquireRequest,
  onProgress?: (p: ProgressInfo) => void,
): DownloadHandle {
  const controller = new AbortController();
  let pausing = false;

  const result: Promise<DownloadResult> = (async () => {
    const total = totalWorkOf(req);

    // 大小先于哈希：省掉一整趟读盘，且「下坏了的半成品」这种最常见的不匹配
    // 能立刻给出准确原因
    const st = await stat(req.sourcePath);
    if (st.size !== req.expectedSize) {
      throw new Error(`源文件大小不符：期望 ${req.expectedSize}，实际 ${st.size}`);
    }

    const hash = createHash("sha256");
    let read = 0;
    const started = Date.now();
    const stream = createReadStream(req.sourcePath, { signal: controller.signal });
    try {
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
        read += (chunk as Buffer).length;
        const elapsed = (Date.now() - started) / 1000;
        onProgress?.({ downloaded: read, total, bytesPerSec: elapsed > 0 ? read / elapsed : 0 });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw pausing
          ? new DownloadError("PAUSED", "本地获取已暂停")
          : new DownloadError("CANCELED", "本地获取已取消");
      }
      throw error;
    }

    const actual = hash.digest("hex");
    if (actual !== req.sha256) {
      throw new Error(`内容不符：期望 sha256 ${req.sha256}，实际 ${actual}`);
    }

    // 执行阶段（任务 7 / 8 填入真正的 move/link/copy 落盘）
    await performAction(req, read, total, started, onProgress, controller, () => pausing);

    // bytes 用校验循环里实测累加的 read，不用调用方声称的 expectedSize：源文件若在
    // stat 之后、读完之前被截断/追加（TOCTOU），实测值才反映真实读到的字节数，
    // 与 downloader.ts 的 finalize() 用实测 finalSize 而非声称值同一口径
    return { ok: true, bytes: read, sha256: actual, sha256Verified: "match", resumedFrom: 0 };
  })();
  // pause/cancel 场景下 result 常常在调用方（manager）真正 await 它之前就已 reject
  // （abort 让流几乎立刻抛错）；这里先挂一个空 handler 防止被判定为未处理拒绝，
  // 不影响外部通过 handle.result 拿到的仍是同一个 promise、同一份 reject 原因
  result.catch(() => undefined);

  return {
    pause(): void {
      pausing = true;
      controller.abort();
    },
    async cancel(): Promise<void> {
      controller.abort();
      // 校验阶段本身不写 .part；这里仍尝试清理是为未来执行阶段（任务 7/8 的 copy 路径）
      // 铺路——那条路径会在这个后缀下落半成品，取消必须能删掉它，不存在时静默忽略即可
      await unlink(req.targetPath + PART_SUFFIX).catch(() => undefined);
    },
    result,
  };
}
