/**
 * 文件页二级栏视图解析（M16 T6）：URL query `?ns=` → 三选一视图。对齐
 * lib/page-header.ts、lib/toolbar-counts.ts 的既有做法——纯逻辑下沉到这里
 * 配 .test.ts，vitest 是 environment: "node"，组件渲染测不了。
 */

export type FilesView =
  | { kind: "all" }
  | { kind: "namespace"; namespace: string }
  | { kind: "meta" };

/** 「全部文件」格的 key：与 models 页的 "all" 同一惯例 */
export const FILES_VIEW_ALL_KEY = "all";

/**
 * 「文件元信息」格的 key 取 "@meta" 而不是 "meta"：命名空间名的正则是
 * `^[a-z0-9][a-z0-9-]*$`（core/schemas.ts 的 namespaceSchema），"@" 不在
 * 这个字符集里，所以 "@meta" 永远不可能被用户建的命名空间遮住。"all" 没有
 * 这个问题——它被同名空间遮住时，「全部文件」仍可以由不带 query 的 `/files`
 * 兜底到达（判定顺序第 3 步），但「文件元信息」没有这条退路：一旦被遮住，
 * 用户将永远无法从 URL 直达这个视图，只能等命名空间被删掉。
 */
export const FILES_VIEW_META_KEY = "@meta";

/**
 * 判定顺序（刻意固定，不能颠倒）：
 * 1. `raw` 命中真实命名空间 → namespace 视图。真实命名空间优先于两个伪键，
 *    因为命名空间名是用户建的、可以恰好撞上 "all" 或（理论上，虽然正则
 *    不允许）"@meta" 这样的字面量——不能让一个后来加的保留键把用户已经在用
 *    的命名空间“抢”走，用户建的东西不该被系统关键字遮蔽。
 * 2. `raw === "@meta"` → meta 视图。
 * 3. 其余（含 undefined、"all"、拼错的值、已删除的命名空间名）→ all 视图，
 *    这是安全默认：宁可把一个查不到语义的 query 值兜底成「看得见全部」，
 *    也不要渲染出一个无法解释自己是什么的空切片。
 */
export function resolveFilesView(raw: string | undefined, namespaces: readonly string[]): FilesView {
  if (raw !== undefined && namespaces.includes(raw)) {
    return { kind: "namespace", namespace: raw };
  }
  if (raw === FILES_VIEW_META_KEY) {
    return { kind: "meta" };
  }
  return { kind: "all" };
}
