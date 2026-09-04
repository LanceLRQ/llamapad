import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { PART_SUFFIX } from "@/lib/download-part";
import { DownloadError, type DownloadHandle, type DownloadResult, type ProgressInfo } from "./downloader";

/**
 * 本地获取执行器（设计 §7.2）
 *
 * 与 startDownload 返回同一形状的 DownloadHandle，因此 manager.kick() 的
 * handle.result.then(...) 整条链路（完成落库 / 暂停保位 / 取消让位 / 失败计数 /
 * 批次归档）一行都不用改——这是本设计把风险控制住的关键。
 *
 * 两阶段：校验（流式读源算 sha256）→ 执行（rename / link / copy）。
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
  /** 期望 sha256（远端 LFS oid）。**null 表示不做比对**——手动关联（规格 §7）时
   *  用户已声明这份文件是对的，内容校验正是那一条被显式放宽的约束。仍然读满全文
   *  算哈希（进度语义不变、算出的值要回写供 file_meta 播种），只是不比对 */
  sha256: string | null;
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

/** 目标已存在（EEXIST）：linkSync 遇到已存在目标会拒绝，需要显式识别后按覆盖处理 */
function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * 流式复制到 <target>.part 再 rename——沿用下载器的原子落盘手法，中途崩溃/取消
 * 不会在目标位置留下半成品。用 .part 后缀还有一个连带好处：repo-files-scan.ts
 * 的 isPartial 天然把它滤掉，扫描不会把正在写的文件当成「已存在的文件」。
 *
 * rename 覆盖已存在的目标是 POSIX 语义自带的，因此 copy（以及复用它的跨盘 move）
 * 天然满足「目标已存在→覆盖」的既有约定（见 performAction 顶部注释），不需要像
 * link 那样额外处理 EEXIST。
 */
async function copyStream(
  req: LocalAcquireRequest,
  readSoFar: number,
  total: number,
  started: number,
  onProgress: ((p: ProgressInfo) => void) | undefined,
  controller: AbortController,
  isPausing: () => boolean,
): Promise<void> {
  const partPath = req.targetPath + PART_SUFFIX;
  let written = 0;
  try {
    await pipeline(
      createReadStream(req.sourcePath),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          written += chunk.length;
          const elapsed = (Date.now() - started) / 1000;
          onProgress?.({
            downloaded: readSoFar + written,
            total,
            bytesPerSec: elapsed > 0 ? (readSoFar + written) / elapsed : 0,
          });
          yield chunk;
        }
      },
      createWriteStream(partPath),
      { signal: controller.signal },
    );
  } catch (error) {
    await unlink(partPath).catch(() => undefined);
    if (controller.signal.aborted) {
      throw isPausing()
        ? new DownloadError("PAUSED", "本地获取已暂停")
        : new DownloadError("CANCELED", "本地获取已取消");
    }
    throw error;
  }
  await rename(partPath, req.targetPath);
}

/**
 * 执行阶段：move（同盘用 rename）、link（硬链接）与 copy/跨盘 move（copyStream 流式
 * 复制）均已落地。目标已存在时统一按「覆盖」处理，对齐 manager.ts enqueueDownload
 * 既有的「大小不符按残缺文件处理、照常覆盖下载」语义——rename/copyStream 的落盘
 * 手法天然覆盖，只有 link 的 linkSync 需要显式补一次删除重试，否则用户看到的是一个
 * 没头没尾的裸 EEXIST。
 */
async function performAction(
  req: LocalAcquireRequest,
  read: number,
  total: number,
  started: number,
  onProgress: ((p: ProgressInfo) => void) | undefined,
  controller: AbortController,
  isPausing: () => boolean,
): Promise<void> {
  // sameFs 的拒绝判定必须先于 mkdir：否则一个注定因跨设备被拒的 link 请求会先在
  // 目标位置留下一个空目录残留
  if (req.action === "link" && !req.sameFs) {
    throw new Error("CROSS_DEVICE：源与目标不在同一文件系统，无法硬链接");
  }

  // 档案目录本身一定在（调用方保证），但落点可能带子目录（如按量化分组的子路径）
  await mkdir(path.dirname(req.targetPath), { recursive: true });

  if (req.action === "link") {
    try {
      await link(req.sourcePath, req.targetPath);
    } catch (error) {
      if (isCrossDevice(error)) throw new Error("CROSS_DEVICE：源与目标不在同一文件系统，无法硬链接");
      if (isAlreadyExists(error)) {
        await unlink(req.targetPath);
        await link(req.sourcePath, req.targetPath);
        return;
      }
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

  // copy，以及跨盘的 move（复制后删源）：源在 models 根之外时用户往往想保留原文件，
  // 所以「移动」在这条路径上的语义是「复制完再删源」，而非 rename
  await copyStream(req, read, total, started, onProgress, controller, isPausing);
  if (req.action === "move") {
    try {
      await unlink(req.sourcePath);
    } catch (error) {
      // 复制已经落位（目标文件完整可用），只是删源这一步失败——不能像 downloader.ts
      // 清理 .part.meta.json 那样静默吞掉：删源对 move 语义而言是核心功能而不是旁路
      // 清理，用户必须知道源文件还占着盘、且不是"任务什么都没做"。真机常见诱因是
      // 旧工具的 models 目录是只读挂载或属于另一个用户
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `SOURCE_DELETE_FAILED：复制已完成（${req.targetPath}），但删除源文件失败：${detail}；` +
          `源文件仍保留在 ${req.sourcePath}，请手动清理或检查该路径的写权限`,
      );
    }
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
    if (req.sha256 !== null && actual !== req.sha256) {
      throw new Error(`内容不符：期望 sha256 ${req.sha256}，实际 ${actual}`);
    }

    // 执行阶段：真正的 move/link/copy 落盘
    await performAction(req, read, total, started, onProgress, controller, () => pausing);

    // bytes 用校验循环里实测累加的 read，不用调用方声称的 expectedSize：源文件若在
    // stat 之后、读完之前被截断/追加（TOCTOU），实测值才反映真实读到的字节数，
    // 与 downloader.ts 的 finalize() 用实测 finalSize 而非声称值同一口径
    return {
      ok: true,
      bytes: read,
      sha256: actual,
      sha256Verified: req.sha256 === null ? "skipped" : "match",
      resumedFrom: 0,
    };
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
      // 先等 result 真正落地（吞掉必然到来的 reject）再清理：copy 阶段会真往 .part
      // 写字节，流没销毁完就去删文件存在竞态窗口——对齐 downloader.ts 的 cancel() 时序
      await result.catch(() => undefined);
      await unlink(req.targetPath + PART_SUFFIX).catch(() => undefined);
    },
    result,
  };
}
