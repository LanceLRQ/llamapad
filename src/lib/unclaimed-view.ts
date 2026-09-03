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
  /** 用户是否给这个文件填过 quant_label 或 mark——不是"file_meta 表里有没有
   * 这一行"（任务 18 复核修的 bug：listFileMeta 会把当时全部游离文件都
   * 幂等写进 file_meta，quant_label/mark 皆为 null，行存在性不能当"有备注"
   * 的判定依据，否则每个游离文件永远显示"有备注"）。调用方必须传入按
   * quant_label/mark 非空过滤过的路径集合，见 server/fileMeta.ts
   * listFileMetaRows 的调用方（page.tsx / unclaimed/route.ts）。 */
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

/**
 * file_meta 行 → 有实际标注（quant_label 或 mark 非空）的路径集合（任务 18
 * 复核修的 bug：调用方原先直接拿"file_meta 有没有这一行"当 hasMeta 的判定
 * 依据，但 listFileMeta 会把当时全部游离 .gguf 文件幂等登记进 file_meta、
 * quant_label/mark 皆为 null，导致每个游离文件都被判成"有备注"）。两个
 * 调用方（files/page.tsx、api/v1/files/unclaimed/route.ts）共用这一个函数，
 * 不各自重复写一遍过滤逻辑。
 */
export function annotatedFileMetaPaths(
  rows: readonly { path: string; quantLabel: string | null; mark: string | null }[],
): Set<string> {
  return new Set(rows.filter((r) => r.quantLabel !== null || r.mark !== null).map((r) => r.path));
}

export function deriveUnclaimed(
  tree: readonly ScanNode[],
  referenced: ReadonlySet<string>,
  repoDirs: readonly string[],
  /** quant_label 或 mark 非空的路径集合（不是"file_meta 有行"的路径集合，
   * 见 UnclaimedFile.hasMeta 上方注释） */
  annotatedPaths: ReadonlySet<string>,
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
        hasMeta: annotatedPaths.has(f.rel),
        sharedWith: (byIno.get(f.ino) ?? []).filter((r) => r !== f.rel),
      });
    }
  }
  return out;
}
