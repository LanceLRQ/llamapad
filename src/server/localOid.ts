import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseHfSidecar } from "@/lib/hf-sidecar";

/** {@link resolveLocalOid} 的缓存入参：full_sha256 连同登记时的 size/mtime，
 *  用于新鲜度校验（复核修复 K-2，见下方函数头注释）。 */
export interface CachedFullSha256 {
  fullSha256: string;
  size: number;
  mtime: number;
}

/**
 * 本地文件内容 oid 的解析（规格 §4.2）。**零哈希计算**——只读元数据。
 *
 * 优先级：
 * 1. `file_meta.full_sha256`（面板下载的由 download_tasks.sha256 播种）——由调用方传入,
 *    但只在 size/mtime 与登记时一致（新鲜度校验）才采信，否则视同没有缓存往下走
 * 2. hf CLI 的下载边车（同目录 `.cache/huggingface/download/<basename>.metadata`）
 * 3. 都没有 → null。补算完整哈希是用户显式动作，走 POST /api/v1/file-meta/checksum
 *    那条 202 路径，不在这里偷偷读满 17 GB（迁移设计最终审查 I7 的教训）
 *
 * 新鲜度校验（复核修复 K-2）：调用方（files/acquire/scan 三条路由）传入的缓存
 * 来自 file_meta 的一次性快照读取（listFileMetaRows 纯 SELECT），不像
 * upsertFileMeta 写入时那样先核对磁盘现状——文件被面板外重新下载覆盖后，
 * 旧的 full_sha256 会被无条件采信，导致"更新完仍显示有更新"的死循环。这里把
 * upsertFileMeta 自己也在用的判据（size/mtime 命中才复用旧值）从"写时机"搬到
 * "读时机"再用一遍，口径统一。
 *
 * 任何 IO 失败一律当「没有这份证据」处理：这是个尽力而为的加速通道，
 * 不该因为一个权限问题让整页 500。
 */
export function resolveLocalOid(absPath: string, cached: CachedFullSha256 | null): string | null {
  if (cached !== null) {
    try {
      const st = statSync(absPath);
      if (st.size === cached.size && st.mtimeMs === cached.mtime) return cached.fullSha256;
    } catch {
      // 拿不到实测 stat——按"缓存不可信"处理，往下走 sidecar/null，不是把
      // 旧值当真；下面 sidecar 分支自己也会再 stat 一次，那次失败同样被
      // 吞掉返回 null，行为一致
    }
  }

  const sidecarPath = path.join(
    path.dirname(absPath),
    ".cache/huggingface/download",
    `${path.basename(absPath)}.metadata`,
  );
  try {
    return parseHfSidecar(readFileSync(sidecarPath, "utf8"), {
      fileMtimeMs: statSync(absPath).mtimeMs,
      sidecarMtimeMs: statSync(sidecarPath).mtimeMs,
    });
  } catch {
    return null;
  }
}
