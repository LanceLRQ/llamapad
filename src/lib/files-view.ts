/**
 * 文件页二级栏视图解析（M16 T6；术语拆分批次改 query 键 `?path=`，见下方
 * resolveFilesQuery）：URL query → 三选一视图。对齐 lib/page-header.ts、
 * lib/toolbar-counts.ts 的既有做法——纯逻辑下沉到这里配 .test.ts，vitest 是
 * environment: "node"，组件渲染测不了。
 */

export type FilesView =
  | { kind: "all" }
  | { kind: "folder"; folder: string }
  | { kind: "meta" };

/** 「全部文件」格的 key：与 models 页的 "all" 同一惯例 */
export const FILES_VIEW_ALL_KEY = "all";

/**
 * 「文件元信息」格的 key 取 "@meta" 而不是 "meta"：文件夹名直接来自磁盘目录名，
 * 不再经过 core/schemas.ts 的 NAMESPACE_PATTERN（`^[a-z0-9][a-z0-9._-]*$`，
 * 阶段 2 B7 放开过点号与下划线）过滤——磁盘允许的字符集仍然更宽（大写字母、
 * 空格、非 ASCII 字符等这条正则依然拒绝，但都是合法目录名），继续按这条
 * 正则筛会把这些真实存在的目录当成非法命名空间过滤掉。
 * "@" 在几乎所有文件系统上都合法，理论上仍有极小概率被人手工建出一个真的叫
 * "@meta" 的目录，但这不是本次改动引入的新风险——文件夹清单本就来自不受约束的
 * 磁盘扫描，接受这个极端场景换来一个不需要额外注册表的保留键，是合理的取舍。
 * "all" 没有类似问题——它被同名文件夹遮住时，「全部文件」仍可以由不带 query 的
 * `/files` 兜底到达（判定顺序第 3 步），但「文件元信息」没有这条退路：一旦被
 * 遮住，用户将永远无法从 URL 直达这个视图，只能等这个文件夹被删掉或改名。
 */
export const FILES_VIEW_META_KEY = "@meta";

/**
 * 判定顺序（刻意固定，不能颠倒）：
 * 1. `raw` 命中真实文件夹 → folder 视图。真实文件夹优先于两个伪键，因为
 *    文件夹名来自磁盘、可能恰好撞上 "all" 这样的字面量——不能让一个后来加的
 *    保留键把磁盘上已经存在的目录"抢"走。
 * 2. `raw === "@meta"` → meta 视图。
 * 3. 其余（含 undefined、"all"、拼错的值、已改名/删除的目录名）→ all 视图，
 *    这是安全默认：宁可把一个查不到语义的 query 值兜底成「看得见全部」，
 *    也不要渲染出一个无法解释自己是什么的空切片。
 */
export function resolveFilesView(raw: string | undefined, folders: readonly string[]): FilesView {
  if (raw !== undefined && folders.includes(raw)) {
    return { kind: "folder", folder: raw };
  }
  if (raw === FILES_VIEW_META_KEY) {
    return { kind: "meta" };
  }
  return { kind: "all" };
}

/**
 * 文件页 query 兼容：新键 `path` 优先，旧键 `ns` 兜底一轮（术语拆分批次把
 * query 键从 `ns` 改成 `path`，语义从"命名空间"变成"相对 models 根的目录
 * 路径"——`ns` 这个名字在文件页语境下已经不准确了，但历史书签/收藏夹里
 * 可能还带着它，直接砍掉会让这些链接突然失效）。这一轮兼容是过渡期措施，
 * 下个批次（多级目录）落地后可以删掉。
 */
export function resolveFilesQuery(path: string | undefined, ns: string | undefined): string | undefined {
  return path ?? ns;
}
