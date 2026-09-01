/**
 * 文档标题锚点 slugify（文档中心批 2）：GitHub 风格——转小写、剥离标点、
 * 空格转连字符，保留 unicode 字母数字/下划线/连字符（中文标题必须可用，
 * `\p{L}` 覆盖 CJK 表意文字，不会被剥成空串）。
 */

/** 单个标题文本 → 基础 slug（不含去重后缀） */
export function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    // 只保留 unicode 字母/数字/下划线/连字符/空白，其余标点整体剥离
    .replace(/[^\p{L}\p{N}_\- \t]+/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * 同名标题去重工厂：同一篇文档内第二个同名标题加 `-1`，第三个加 `-2`……
 * 必须每篇文档各建一个实例（用工厂函数而不是模块级可变状态）——去重计数
 * 挂在模块级会让并发请求间的不同文档互相污染彼此的编号。
 */
export function createHeadingSlugger(): (heading: string) => string {
  const seen = new Map<string, number>();
  return function slug(heading: string): string {
    const base = slugifyHeading(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}
