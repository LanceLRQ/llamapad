import { repoDirOf } from "./repo-path";

/**
 * 游离文件清单派生（设计 §4.1 / §9.3）
 *
 * 游离 = refs === 0，附 inRepoDir / hasMeta 两个正交标签。
 * 硬链接产生的第二个路径同样算游离——它确实还没被任何配置引用；
 * 用 sharedWith 标出与它共用同一 inode 的其他路径，供 UI 提示
 * 「删除链接不会释放磁盘空间」。
 */
export interface UnclaimedFile {
  rel: string;
  size: number;
  ino: number;
  inRepoDir: string | null;
  hasMeta: boolean;
  /** 与本文件共用同一 inode 的其他路径 */
  sharedWith: string[];
}

export interface ScanNode {
  folder: string;
  files: { rel: string; size: number; mtime: number; ino: number }[];
}

/**
 * 某个文件的硬链接同伴清单（删除确认框用，任务 18）：与 deriveUnclaimed
 * 内部的 byIno 映射同一思路，但独立成一个按需查询的函数——deriveUnclaimed
 * 一次性对全部游离文件建索引服务于列表页，这里只关心用户正要删除的那
 * 一个文件，且不限于游离文件（已被引用的文件同样可能与游离文件共用同一
 * 份数据，删除确认框要覆盖这种情形）。
 */
export function sharedInodePaths(tree: readonly ScanNode[], rel: string): string[] {
  let targetIno: number | null = null;
  outer: for (const g of tree) {
    for (const f of g.files) {
      if (f.rel === rel) {
        targetIno = f.ino;
        break outer;
      }
    }
  }
  if (targetIno === null) return [];

  const out: string[] = [];
  for (const g of tree) {
    for (const f of g.files) {
      if (f.ino === targetIno && f.rel !== rel) out.push(f.rel);
    }
  }
  return out;
}

export function deriveUnclaimed(
  tree: readonly ScanNode[],
  referenced: ReadonlySet<string>,
  repoDirs: readonly string[],
  metaPaths: ReadonlySet<string>,
): UnclaimedFile[] {
  // inode → 全部路径：共用关系要看全树，不能只看游离的那部分
  // （档案目录里被引用的那份也占同一个 inode，是判断「删了会不会真的释放空间」的关键）
  const byIno = new Map<number, string[]>();
  for (const g of tree) {
    for (const f of g.files) {
      const list = byIno.get(f.ino);
      if (list) list.push(f.rel);
      else byIno.set(f.ino, [f.rel]);
    }
  }

  const out: UnclaimedFile[] = [];
  for (const g of tree) {
    for (const f of g.files) {
      if (!f.rel.toLowerCase().endsWith(".gguf")) continue;
      if (referenced.has(f.rel)) continue;
      out.push({
        rel: f.rel,
        size: f.size,
        ino: f.ino,
        inRepoDir: repoDirOf(g.folder, repoDirs),
        hasMeta: metaPaths.has(f.rel),
        sharedWith: (byIno.get(f.ino) ?? []).filter((r) => r !== f.rel),
      });
    }
  }
  return out;
}
