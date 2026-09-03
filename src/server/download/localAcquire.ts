import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
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

/**
 * 执行阶段占位（任务 7/8 补齐）。
 *
 * link / move(同盘) 不需要额外落盘工作——校验阶段读满一遍源文件就已经花掉
 * totalWorkOf 给它俩分配的全部预算，这里暂不创建 targetPath（真正的
 * fs.link / fs.rename 调用留给任务 7/8）。copy / move(跨盘) 还欠总量后一半的
 * 复制写入，本任务未实现：宁可显式抛错，也不假装复制已经完成——静默返回会让
 * 调用方以为本地文件真的落位了。
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
  const needsCopyPhase = req.action === "copy" || (req.action === "move" && !req.sameFs);
  if (needsCopyPhase) {
    throw new Error("本地复制执行阶段尚未实现，见任务 7/8");
  }
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

    return { ok: true, bytes: req.expectedSize, sha256: actual, sha256Verified: "match", resumedFrom: 0 };
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
