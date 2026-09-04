import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseHfSidecar } from "@/lib/hf-sidecar";

/**
 * 本地文件内容 oid 的解析（规格 §4.2）。**零哈希计算**——只读元数据。
 *
 * 优先级：
 * 1. `file_meta.full_sha256`（面板下载的由 download_tasks.sha256 播种）——由调用方传入
 * 2. hf CLI 的下载边车（同目录 `.cache/huggingface/download/<basename>.metadata`）
 * 3. 都没有 → null。补算完整哈希是用户显式动作，走 POST /api/v1/file-meta/checksum
 *    那条 202 路径，不在这里偷偷读满 17 GB（迁移设计最终审查 I7 的教训）
 *
 * 任何 IO 失败一律当「没有这份证据」处理：这是个尽力而为的加速通道，
 * 不该因为一个权限问题让整页 500。
 */
export function resolveLocalOid(absPath: string, cachedFullSha256: string | null): string | null {
  if (cachedFullSha256 !== null) return cachedFullSha256;

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
