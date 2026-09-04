import { SHA256_PATTERN } from "./acquire-match";

/**
 * huggingface_hub 下载边车的解析（规格 §4.2 来源 2）。
 *
 * 边车路径是 `<文件所在目录>/.cache/huggingface/download/<basename>.metadata`，
 * 内容三行：commit hash（40 hex）、etag、时间戳。etag 对 LFS 文件就是内容 sha256
 * ——真机实测 927 MB 的 mmproj-F16.gguf，边车第二行与 sha256sum 逐字符相同。
 *
 * 这是 huggingface_hub 的内部实现细节，不是公开契约，随时可能变形。所以三条防御
 * 缺一不可，任何一条不满足就当没有这份证据（返回 null），绝不猜：
 * 1. 恰好三行（多一行少一行都说明格式变了）
 * 2. 第二行匹配 64 位小写十六进制
 * 3. 文件 mtime 不晚于边车 mtime——晚了说明下载完成后文件被改动过，
 *    边车记的 etag 已不代表当前内容，用它去判版本会得出反的结论
 *
 * 读盘那层在 server/localOid.ts；本函数只做解析，保持零 IO 可测。
 */
export function parseHfSidecar(
  content: string,
  mtimes: { fileMtimeMs: number; sidecarMtimeMs: number },
): string | null {
  if (mtimes.fileMtimeMs > mtimes.sidecarMtimeMs) return null;

  // 末尾换行不算一行；\r\n 一并容忍
  const lines = content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length !== 3) return null;

  const etag = lines[1].trim();
  return SHA256_PATTERN.test(etag) ? etag : null;
}
