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
