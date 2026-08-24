import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, statfs, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 自研 HTTP 下载器（M2 Task 4，设计 §8）：fetch 流式下载 + HTTP Range 断点续传 +
 * sha256 增量校验 + 原子落盘（.part → rename）。纯 Node 模块，不 import 任何 Next 类型；
 * 路径由调用方（下载 manager）算好传入，本模块不读面板配置。
 */

/** 下载请求：url + 最终落盘绝对路径 + 可选的总量/哈希（HF LFS 的 size/oid） */
export interface DownloadRequest {
  url: string;
  /** 最终落盘绝对路径（.part/.part.meta.json 基于它派生） */
  targetPath: string;
  /** 总字节数（HF LFS size）；未知则 undefined */
  expectedSize?: number;
  /** 期望 sha256（HF LFS oid）；URL 直链可缺省 */
  sha256?: string;
  /** 附加请求头（HF 认证等） */
  headers?: Record<string, string>;
  /** undici ProxyAgent 实例（可选，走代理下载） */
  dispatcher?: unknown;
}

/** 下载句柄：pause 保留 .part（可续传），cancel 删 .part；result 拿最终结果 */
export interface DownloadHandle {
  pause(): void;
  cancel(): Promise<void>;
  result: Promise<DownloadResult>;
}

export interface DownloadResult {
  ok: boolean;
  bytes: number;
  sha256?: string;
  sha256Verified: "match" | "mismatch" | "skipped";
  /** 续传起点（0 = 全新下载） */
  resumedFrom: number;
}

export interface ProgressInfo {
  downloaded: number;
  total: number | null;
  bytesPerSec: number;
}

/**
 * 下载器错误：普通 Error 子类 + code 字段判别。
 * 取舍：abort 使异常天然从 fetch/流内部沿 reject 通道抛出，若用 result 状态机（不抛错）
 * 每个调用方 await 点都要手动判 status，违背项目"失败即异常"的错误风格；用 Symbol 标记
 * 则在模块被 Next 双重打包加载时 instanceof 会失效。带 code 的 Error 子类既可
 * instanceof/导出判别函数判别，序列化进日志后仍可读（code 字段随 toString 保留）。
 */
export type DownloadErrorCode =
  | "PAUSED"
  | "CANCELED"
  | "SOURCE_CHANGED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "SIZE_MISMATCH"
  | "SHA256_MISMATCH"
  | "DISK_FULL";

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  constructor(code: DownloadErrorCode, message: string) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
  }
}

/** result reject 的错误是否为"用户暂停"（.part 已保留，外部重新调用即续传） */
export function isPausedError(e: unknown): boolean {
  return e instanceof DownloadError && e.code === "PAUSED";
}

/** result reject 的错误是否为"用户取消"（.part 已删除） */
export function isCanceledError(e: unknown): boolean {
  return e instanceof DownloadError && e.code === "CANCELED";
}

/** .part 旁挂的元数据：url/etag/expectedSize 任一与当前请求不一致 → .part 作废重来 */
interface PartMeta {
  version: 1;
  url: string;
  etag: string | null;
  expectedSize: number | null;
  sha256: string | null;
}

/** 人类可读字节数（错误消息用；不 import src/lib，保持本模块零依赖） */
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
  if (e instanceof Error) {
    const cause = (e as { cause?: { message?: string } }).cause;
    return cause?.message ?? e.message; // "fetch failed" 的真实原因在 cause 里
  }
  return String(e);
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** 磁盘预检：目标分区剩余空间不足 neededBytes 时抛错（startDownload 内部不自动调，由 manager 决定） */
export async function checkDiskSpace(dir: string, neededBytes: number): Promise<void> {
  const fsStat = await statfs(dir);
  const available = fsStat.bsize * fsStat.bavail;
  if (available < neededBytes) {
    throw new DownloadError(
      "DISK_FULL",
      `磁盘空间不足：需要 ${formatBytes(neededBytes)}，剩余 ${formatBytes(available)}（${dir}）`,
    );
  }
}

/** 速度计：移动窗口（约 2s）平均；样本时间跨度不足时回退整个会话的平均值（分母下限 1ms） */
class SpeedMeter {
  private readonly windowMs = 2000;
  private samples: { t: number; b: number }[] = [];
  private readonly sessionStart: number;
  private readonly sessionBaseBytes: number;

  constructor(startT: number, baseBytes: number) {
    this.sessionStart = startT;
    this.sessionBaseBytes = baseBytes;
  }

  /** 传入累计字节数（含续传基数），返回当前速度 bytes/s */
  update(downloaded: number, now: number): number {
    this.samples.push({ t: now, b: downloaded });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 1 && this.samples[1].t <= cutoff) this.samples.shift();
    const anchor = this.samples[0];
    const dtMs = now - anchor.t;
    if (dtMs > 0) return ((downloaded - anchor.b) / dtMs) * 1000;
    const sessionMs = Math.max(now - this.sessionStart, 1);
    return ((downloaded - this.sessionBaseBytes) / sessionMs) * 1000;
  }
}

/** 封装 fetch：统一注入 signal/headers/dispatcher（dispatcher 是 undici 扩展字段，cast 绕过 DOM 类型） */
function doFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  dispatcher?: unknown,
): Promise<Response> {
  const opts: Record<string, unknown> = { ...init, signal };
  if (dispatcher !== undefined) opts.dispatcher = dispatcher;
  return fetch(url, opts as RequestInit);
}

/** 读 .part + .meta：任一缺失/损坏返回 null（无法续传） */
async function readExistingPart(
  partPath: string,
  metaPath: string,
): Promise<{ partSize: number; meta: PartMeta } | null> {
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as PartMeta;
    if (meta.version !== 1) return null;
    return { partSize: (await stat(partPath)).size, meta };
  } catch {
    return null;
  }
}

/** 续传一致性：url 必须相同；etag/expectedSize 双方都有值才比较（有则比） */
function metaMatches(
  meta: PartMeta,
  req: DownloadRequest,
  headTotal: number | null,
  headEtag: string | null,
): boolean {
  if (meta.url !== req.url) return false;
  if (meta.etag !== null && headEtag !== null && meta.etag !== headEtag) return false;
  const currentSize = headTotal ?? req.expectedSize ?? null;
  if (meta.expectedSize !== null && currentSize !== null && meta.expectedSize !== currentSize) {
    return false;
  }
  return true;
}

/** 续传时把已有 .part 喂进增量哈希（与下载体字节序一致） */
async function seedHashFromPart(partPath: string, hash: Hash): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(partPath);
    rs.on("data", (c) => hash.update(c as Buffer));
    rs.on("error", reject);
    rs.on("end", resolve);
  });
}

/**
 * 启动一次下载（HEAD 预检 → 续传判定 → 流式写 → 校验 → 原子 rename）。
 * 暂停/取消后不内部重试：恢复 = 外部重新调用（续传语义）；同一 targetPath 的并发互斥由 manager 负责。
 */
export function startDownload(
  req: DownloadRequest,
  onProgress?: (p: ProgressInfo) => void,
): DownloadHandle {
  const partPath = req.targetPath + ".part";
  const metaPath = req.targetPath + ".part.meta.json";
  const controller = new AbortController();
  let state: "running" | "paused" | "canceled" = "running";

  const result = run();

  return {
    pause() {
      if (state === "running") {
        state = "paused";
        controller.abort();
      }
    },
    async cancel() {
      if (state === "running") {
        state = "canceled";
        controller.abort();
      }
      try {
        await result;
      } catch {
        /* 取消必然 reject，吞掉以拿到清理时机 */
      }
      await Promise.allSettled([unlink(partPath), unlink(metaPath)]);
    },
    result,
  };

  async function run(): Promise<DownloadResult> {
    // 把 abort/网络异常翻译成带 code 的 DownloadError（state 优先于异常类型判定）
    const mapFailure = (e: unknown): DownloadError => {
      if (state === "paused") return new DownloadError("PAUSED", "下载已暂停");
      if (state === "canceled") return new DownloadError("CANCELED", "下载已取消");
      if (e instanceof DownloadError) return e;
      if (isAbortError(e)) return new DownloadError("CANCELED", "下载已取消");
      return new DownloadError("NETWORK_ERROR", `网络错误: ${errMessage(e)}（${req.url}）`);
    };

    try {
      await mkdir(path.dirname(req.targetPath), { recursive: true });

      // ---- HEAD 预检：总量/ETag/Accept-Ranges（发生在任何 .part 写入之前） ----
      const head = { total: null as number | null, etag: null as string | null };
      try {
        const hr = await doFetch(req.url, { method: "HEAD" }, controller.signal, req.dispatcher);
        if (hr.ok) {
          const cl = hr.headers.get("content-length");
          head.total = cl !== null ? Number(cl) : null;
          head.etag = hr.headers.get("etag");
          if (req.expectedSize !== undefined && head.total !== null && head.total !== req.expectedSize) {
            throw new DownloadError(
              "SOURCE_CHANGED",
              `源文件大小与预期不符：预期 ${formatBytes(req.expectedSize)}，服务器实际 ${formatBytes(head.total)}（${req.url}）`,
            );
          }
        }
      } catch (e) {
        if (e instanceof DownloadError) throw e; // 预检结论必须上抛
        if (isAbortError(e) || state !== "running") throw mapFailure(e); // 暂停/取消发生在 HEAD 阶段
        // 其余（网络抖动/服务器不支持 HEAD）容忍：总量/ETag 缺省，留待 GET 阶段兜底
      }

      // ---- 完成校验 + 原子落盘（供正常完成与".part 已完整但 rename 前崩溃"两路复用） ----
      const finalize = async (
        hash: Hash,
        total: number | null,
        resumedFrom: number,
        finalSize: number,
      ): Promise<DownloadResult> => {
        const actualSha = hash.digest("hex");
        if (total !== null && finalSize !== total) {
          await Promise.allSettled([unlink(partPath), unlink(metaPath)]);
          throw new DownloadError(
            "SIZE_MISMATCH",
            `下载不完整：预期 ${formatBytes(total)}，实际 ${formatBytes(finalSize)}（${req.url}）`,
          );
        }
        let verified: DownloadResult["sha256Verified"] = "skipped";
        if (req.sha256 !== undefined) {
          if (actualSha !== req.sha256.toLowerCase()) {
            await Promise.allSettled([unlink(partPath), unlink(metaPath)]);
            throw new DownloadError(
              "SHA256_MISMATCH",
              `sha256 校验失败：期望 ${req.sha256}，实际 ${actualSha}（${req.url}）`,
            );
          }
          verified = "match";
        }
        await rename(partPath, req.targetPath); // 同目录 rename，原子落位
        await unlink(metaPath).catch(() => undefined);
        return { ok: true, bytes: finalSize, sha256: actualSha, sha256Verified: verified, resumedFrom };
      };

      // ---- 续传判定：.part 与 .meta 都在、与当前请求/源一致、且不超总量 ----
      const existing = await readExistingPart(partPath, metaPath);
      let resumedFrom = 0;
      let hash = createHash("sha256");
      if (existing && existing.partSize > 0) {
        if (
          metaMatches(existing.meta, req, head.total, head.etag) &&
          (head.total === null || existing.partSize <= head.total)
        ) {
          resumedFrom = existing.partSize;
        } else {
          // meta 不一致（url 换了/源变了）或 part 超过总量（损坏）→ 作废重来
          await Promise.allSettled([unlink(partPath), unlink(metaPath)]);
        }
      }

      // 特例：.part 已等于总量（上次 rename 前崩溃）→ 免网络直接校验落位
      if (resumedFrom > 0 && head.total !== null && resumedFrom === head.total) {
        await seedHashFromPart(partPath, hash);
        return await finalize(hash, head.total, resumedFrom, resumedFrom);
      }

      // ---- GET（带 Range）----
      const headers: Record<string, string> = { ...req.headers };
      if (resumedFrom > 0) headers["Range"] = `bytes=${resumedFrom}-`;
      const resp = await doFetch(req.url, { headers }, controller.signal, req.dispatcher);

      let appending = false; // 206 = 服务器认了 Range，追加写
      let total = head.total;
      if (resumedFrom > 0 && resp.status === 206) {
        appending = true;
        const cl = resp.headers.get("content-length");
        if (total === null && cl !== null) total = resumedFrom + Number(cl);
      } else {
        // 全新下载；或续传请求被无视（200 全量）/ 416（part 越界，总量未知时可能）→ 删 .part 重写
        if (resumedFrom > 0) {
          await Promise.allSettled([unlink(partPath), unlink(metaPath)]);
          resumedFrom = 0;
          hash = createHash("sha256");
        }
        const cl = resp.headers.get("content-length");
        if (cl !== null) total = Number(cl);
        if (total === null) total = req.expectedSize ?? null;
      }
      if (!resp.ok) {
        throw new DownloadError("HTTP_ERROR", `下载失败（HTTP ${resp.status}，${req.url}）`);
      }
      if (!resp.body) {
        throw new DownloadError("HTTP_ERROR", `响应无内容（${req.url}）`);
      }

      // 先落元数据再写数据：崩溃时两者同在，续传判定才成立
      const meta: PartMeta = {
        version: 1,
        url: req.url,
        etag: head.etag,
        expectedSize: req.expectedSize ?? total,
        sha256: req.sha256 ?? null,
      };
      await writeFile(metaPath, JSON.stringify(meta), "utf8");

      if (appending) {
        await seedHashFromPart(partPath, hash); // 旧字节先喂哈希，新字节再增量
      }
      let sessionBytes = 0;
      const meter = new SpeedMeter(Date.now(), resumedFrom);
      const fh = await open(partPath, appending ? "a" : "w");
      try {
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await fh.write(value);
          hash.update(value);
          sessionBytes += value.byteLength;
          onProgress?.({
            downloaded: resumedFrom + sessionBytes,
            total,
            bytesPerSec: meter.update(resumedFrom + sessionBytes, Date.now()),
          });
        }
      } finally {
        await fh.close();
      }

      return await finalize(hash, total, resumedFrom, resumedFrom + sessionBytes);
    } catch (e) {
      throw mapFailure(e);
    }
  }
}
