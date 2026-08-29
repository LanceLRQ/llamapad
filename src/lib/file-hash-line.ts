/**
 * sha256 展示截断纯逻辑（M16 T6）：file-meta-table.tsx 的 hashline 用
 * "截断 + 悬停全值"展示 sampleSha256/fullSha256，这里只负责截断判定，
 * 文案（"尚未计算"、孤儿行的保留提示）走 i18n，不下沉到这个模块。
 */

export interface HashSegment {
  /** 截断展示值（前 8 位 + 省略号）或 null 表示未计算 */
  short: string | null;
  /** 悬停用的完整值；未计算为 null */
  full: string | null;
}

/**
 * 截断规则：取前 8 位 + "…"。入参短于（或恰好等于）8 位时原样返回、不加
 * 省略号——哈希理应是 64 位，短值本身就是脏数据，截断只会让它看起来和
 * 正常截断的哈希一样"正常"，反而藏起了它不对劲这件事。
 */
export function truncateHash(value: string | null): HashSegment {
  if (value === null || value === "") {
    return { short: null, full: null };
  }
  if (value.length <= 8) {
    return { short: value, full: value };
  }
  return { short: `${value.slice(0, 8)}…`, full: value };
}
