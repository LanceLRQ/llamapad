import { realpathSync } from "node:fs";
import { normalize, sep } from "node:path";

/**
 * acquire 的源路径守卫（设计 §8.1）
 *
 * 扫描结果不入库，用户确认时源路径由前端带回——所以服务端必须自己再验一遍，
 * 不能信前端。这与 README-LLM 批「前后端各回证一次」是同一个模式。
 *
 * 目录边界判定复用 core/paths 的语义：相等或以 root + 分隔符开头，
 * 纯字符串前缀不算（防 /host-models 与 /host-models2 误匹配）。
 */
export class AcquireGuardError extends Error {
  constructor(readonly code: "OUT_OF_SCOPE" | "NOT_FOUND" | "MISMATCH", message: string) {
    super(message);
    this.name = "AcquireGuardError";
  }
}

/** 判断 p 是否位于 root 之内（相等，或以 root+目录分隔符 开头）；两者都先 normalize */
export function isInside(root: string, p: string): boolean {
  const r = normalize(root);
  const t = normalize(p);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** 纯字符串级判定，不做任何 IO——`..` 穿越经 normalize 消解后即可判定，
 *  不需要文件真实存在（route 层会在这之后才 statSync 验存在性）。 */
export function assertSourceAllowed(sourcePath: string, allowedRoots: readonly string[]): void {
  if (!allowedRoots.some((root) => isInside(root, sourcePath))) {
    throw new AcquireGuardError(
      "OUT_OF_SCOPE",
      `源路径不在允许范围内: ${sourcePath}`,
    );
  }
}

/**
 * 符号链接逃逸防护：assertSourceAllowed 只按字符串前缀判定，挡不住范围内的
 * 符号链接指向范围外——例如 /host-models/evil 是一个指向 /etc 的符号链接，
 * 字符串判定会放行，但 statSync/读取实际落到的是 /etc 下的文件。这里对
 * realpath 之后的真实落点重新判一遍范围，判定手法与 docs.ts 的符号链接
 * 逃逸防护同源（realpath 前缀比较）。
 *
 * 要求源路径已经存在（route 层调用顺序：先 assertSourceAllowed → statSync
 * 确认存在 → 这里）；解析失败（含允许根本身解析失败）一律判定越界，不吞错
 * 兜底成放行。
 */
export function assertRealPathAllowed(sourcePath: string, allowedRoots: readonly string[]): void {
  let real: string;
  try {
    real = realpathSync(sourcePath);
  } catch {
    throw new AcquireGuardError("NOT_FOUND", `源路径无法解析: ${sourcePath}`);
  }

  const ok = allowedRoots.some((root) => {
    try {
      return isInside(realpathSync(root), real);
    } catch {
      return false;
    }
  });
  if (!ok) {
    throw new AcquireGuardError("OUT_OF_SCOPE", `源路径的真实位置不在允许范围内: ${sourcePath}`);
  }
}
