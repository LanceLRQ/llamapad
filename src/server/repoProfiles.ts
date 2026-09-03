import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidBaseDir, isValidRepoId, repoDirOf, repoTargetDir } from "../lib/repo-path";
import { buildRefMap } from "./filesApi";
import { MAX_DIR_DEPTH, MAX_PATH_DEPTH, type FolderFiles } from "./fsScanner";
import { renameFolder } from "./folders";

/**
 * 仓库档案服务层（设计 §6）。
 *
 * 档案 = DB 行 + 目录内隐藏标记文件的双真源：DB 让列表页零 IO，标记文件让整个
 * 目录被手动搬走后仍能被 scanRepoMarkers 找回来认领。标记文件以点开头，
 * fsScanner 的隐藏项跳过规则让它不会污染文件页列表（既有行为，无需改动）。
 *
 * 注意命名：server/repo/models.ts 已有 ModelRepo 类型（模型仓储接口），档案
 * 一律用 RepoProfile，不得复用那个名字。
 */

/** 档案目录内的标记文件名（点开头 → scanTree 与 glob 一律跳过） */
export const REPO_MARKER_FILENAME = ".llamapad-repo";

export type RepoProfileErrorCode = "INVALID_NAME" | "NOT_FOUND" | "CONFLICT" | "LOCKED";

export class RepoProfileError extends Error {
  constructor(
    readonly code: RepoProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepoProfileError";
  }
}

/** 错误码 → HTTP 状态，与 folders.ts / filesApi.ts 的既有契约一致 */
export function repoProfileErrorStatus(code: RepoProfileErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "LOCKED":
      return 423;
    default:
      return 400;
  }
}

export interface RepoProfile {
  id: number;
  repo: string;
  baseDir: string;
  /** 派生字段：repoTargetDir(baseDir, repo)，调用方不必自己拼 */
  targetDir: string;
  createdAt: number;
}

export interface RepoProfileDeps {
  db: Database.Database;
  /** 面板视角 models 根：存在性判断、buildRefMap、以及本文件全部
   * mkdir/rm/writeFile 落盘都走这一个根——宿主视角根在容器内不可见，
   * 只用于交给 Docker 做 bind 挂载，不能拿来拼面板自己要读写的本地路径
   * （见 folders.ts 同款理由，任务 H 修复的真机缺陷） */
  modelsRoot: string;
  /** 当前运行模型名（无则 null），用于 LOCKED 判定 */
  runningModel: string | null;
}

interface Row {
  id: number;
  repo: string;
  base_dir: string;
  created_at: number;
}

function toProfile(row: Row): RepoProfile {
  return {
    id: row.id,
    repo: row.repo,
    baseDir: row.base_dir,
    targetDir: repoTargetDir(row.base_dir, row.repo),
    createdAt: row.created_at,
  };
}

export function listProfiles(db: Database.Database): RepoProfile[] {
  const rows = db.prepare("SELECT * FROM model_repos ORDER BY id").all() as Row[];
  return rows.map(toProfile);
}

export function getProfile(db: Database.Database, id: number): RepoProfile | null {
  const row = db.prepare("SELECT * FROM model_repos WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toProfile(row);
}

export interface RepoProfileStats extends RepoProfile {
  /** 档案目录及其子目录内的文件总数 */
  fileCount: number;
  /** 档案目录及其子目录内的文件总字节数（同一档案内的硬链接按 inode 去重，
   *  只计一次——见 decorateProfileStats 注释） */
  bytes: number;
  /** bytes 里与**全树任意别处**共用同一 inode 的字节数——别的档案、同档案内
   *  的另一条路径、以及不属于任何档案的散落文件都算数（判定见
   *  decorateProfileStats 的 inoCount，它建在整棵树上，不区分对方在哪）。
   *  含义是「这些字节删了也不一定真能释放」，不是「与其他档案共用」。
   *  硬链接落地后这个数可以不为 0 */
  sharedBytes: number;
  /** 档案目录在磁盘上是否还存在——scanTree 对空目录也会返回一个 files 为空
   *  的条目，所以刚建的空档案是 true，只有目录被手动删掉才是 false。它不是
   *  「有没有文件」，那是 fileCount 的事 */
  dirExists: boolean;
}

/**
 * 档案列表派生字段的共用口径：`GET /api/v1/repos` 与
 * `app/(panel)/models/repos/page.tsx` 都要给每个档案拼上 fileCount/bytes/
 * dirExists 三项，此前两处各自抄了一份完全相同的 12 行——抽到这里，口径
 * 只留一份，以后改 dirExists 之类的语义不会漏改一边（任务 9 复核 D2）。
 *
 * bytes 按 inode 去重求和：硬链接落地后，同一份数据可能被两个档案目录各
 * 挂一个路径，直接按 size 累加会让两个档案各报一次完整大小、磁盘实际只少
 * 了一份——这是本任务（inode 去重）要修的口径问题。sharedBytes 额外标出
 * 「这些字节与全树别处共用」（对方在哪不区分：别的档案、本档案另一条路径、
 * 档案外的散落文件都算），供 UI 提示，不从 bytes 里扣除（档案自己看，
 * 这个文件确实占了这么多）。
 */
export function decorateProfileStats(
  profiles: readonly RepoProfile[],
  tree: readonly FolderFiles[],
): RepoProfileStats[] {
  // 全树 inode → 出现次数：共用判定需要全局视野，不能只看本档案内。
  // 「别处」不限于别的档案——档案外的散落文件同样让这份数据删了也不释放空间
  const inoCount = new Map<number, number>();
  for (const g of tree) for (const f of g.files) inoCount.set(f.ino, (inoCount.get(f.ino) ?? 0) + 1);

  return profiles.map((p) => {
    // 档案目录及其子目录下的全部文件（标记文件是隐藏项，scanTree 已跳过）
    const entries = tree.filter(
      (g) => g.folder === p.targetDir || g.folder.startsWith(`${p.targetDir}/`),
    );
    const files = entries.flatMap((g) => g.files);
    const fileCount = files.length;

    // 本档案内按 inode 去重后求和：同一份数据被硬链接两次，占盘只有一份
    const seen = new Set<number>();
    let bytes = 0;
    let sharedBytes = 0;
    for (const f of files) {
      if (seen.has(f.ino)) continue;
      seen.add(f.ino);
      bytes += f.size;
      if ((inoCount.get(f.ino) ?? 0) > 1) sharedBytes += f.size;
    }
    return { ...p, fileCount, bytes, sharedBytes, dirExists: entries.length > 0 };
  });
}

/**
 * 目标落盘目录可用性判定（缺陷 2 修复）：档案唯一性此前只按 DB 的
 * UNIQUE(base_dir, repo) 精确判，挡不住两种拆法派生出同一 targetDir 的情况
 * （如 base="hf/o" + repo="R" 与 base="hf" + repo="o/R" 都落在 "hf/o/R"）——
 * 两条档案行共管一个目录，删其中一条的文件会把另一条的文件一起 rmSync 掉。
 * 也挡不住档案套档案（moveProfile 把 A 移进 B 的目录内部）：scanRepoMarkers
 * 命中 B 的标记后不再往下探，A 从此认领不回来，B 的 fileCount/local 又会把
 * A 的文件算成自己的。
 *
 * `excludeId` 供 moveProfile 用——判定时要排除档案自己（否则移动前的自身
 * 旧目录会被误判为"与自己冲突"）。
 *
 * 两条判定复用同一个 repoDirOf（按目录边界比较，不是裸 startsWith——
 * "hf/o/R-extra" 的前缀匹配 "hf/o/R" 但显然是另一个目录）：
 * 1. dir 与某个既有档案目录相同，或落在它内部 → repoDirOf(dir, others) 命中
 * 2. 某个既有档案目录落在 dir 内部（反向嵌套）→ 把参数对调，逐个反查
 */
function assertDirAvailable(db: Database.Database, dir: string, excludeId?: number): void {
  const others = listProfiles(db)
    .filter((p) => p.id !== excludeId)
    .map((p) => p.targetDir);

  const parent = repoDirOf(dir, others);
  if (parent !== null) {
    throw new RepoProfileError(
      "CONFLICT",
      `CONFLICT: 目标目录与已登记档案 ${parent} 相同或互相嵌套，档案不得嵌套: ${dir}`,
    );
  }

  const child = others.find((other) => repoDirOf(other, [dir]) !== null);
  if (child !== undefined) {
    throw new RepoProfileError(
      "CONFLICT",
      `CONFLICT: 已登记档案 ${child} 落在目标目录 ${dir} 内部，档案不得嵌套`,
    );
  }
}

export interface CreateProfileArgs {
  repo: string;
  baseDir: string;
}

export interface CreatedProfile extends RepoProfile {
  /** true 表示目录本来就在（认领既有文件），false 表示新建了空目录 */
  claimed: boolean;
}

/**
 * 新建或认领档案。
 *
 * 目录已存在但没有标记文件时**也认领**（补写标记），不报 CONFLICT：目录名要
 * 恰好等于 `<base>/<owner>/<repo>` 这样的多级路径，巧合概率为零 —— 它必然是
 * 用户手动按约定放的，或是删档案时选了「保留文件」留下的。拒绝只会制造一条
 * 死路（既不能认领，又不能用这个 base 建档案）。
 */
export function createProfile(deps: RepoProfileDeps, args: CreateProfileArgs): CreatedProfile {
  const { db, modelsRoot } = deps;
  const { repo, baseDir } = args;

  if (!isValidRepoId(repo)) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 仓库 ID 非法: ${repo}`);
  }
  if (!isValidBaseDir(baseDir)) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 存放目录非法: ${baseDir}`);
  }
  const dir = repoTargetDir(baseDir, repo);
  if (dir.split("/").length > MAX_DIR_DEPTH) {
    throw new RepoProfileError(
      "INVALID_NAME",
      `INVALID_NAME: 落盘目录层级超过上限（${MAX_DIR_DEPTH} 层）: ${dir}`,
    );
  }

  const dup = db
    .prepare("SELECT id FROM model_repos WHERE base_dir = ? AND repo = ?")
    .get(baseDir, repo);
  if (dup !== undefined) {
    throw new RepoProfileError("CONFLICT", `CONFLICT: 该仓库在此目录下已有档案: ${dir}`);
  }
  // 精确判定之外，还要挡住"两种拆法派生出同一 targetDir"与"落进既有档案
  // 目录内部/包住既有档案目录"两种情况（缺陷 2，见 assertDirAvailable 注释）
  assertDirAvailable(db, dir);

  const abs = join(modelsRoot, dir);
  const claimed = existsSync(abs);
  mkdirSync(abs, { recursive: true });
  // 标记文件已存在才跳过写入：认领既有目录时不能覆写，否则会把 createdAt
  // 刷成现在，丢掉档案真实的创建时间——与 repair 路由（POST
  // /api/v1/repos/[id]/repair）的同一不变量，两处此前给出了相反的处理。
  const marker = join(abs, REPO_MARKER_FILENAME);
  if (!existsSync(marker)) {
    writeFileSync(marker, `${JSON.stringify({ repo, createdAt: Date.now() }, null, 2)}\n`);
  }

  const now = Date.now();
  const info = db
    .prepare("INSERT INTO model_repos(repo, base_dir, created_at) VALUES (?, ?, ?)")
    .run(repo, baseDir, now);
  return {
    id: Number(info.lastInsertRowid),
    repo,
    baseDir,
    targetDir: dir,
    createdAt: now,
    claimed,
  };
}

/**
 * 全盘找标记文件。递归下降到 MAX_PATH_DEPTH 为止；命中标记文件的目录不再往下
 * 找（档案目录内部不会再嵌套档案）。用于新建时的复用提示与孤儿目录认领。
 */
export function scanRepoMarkers(modelsRoot: string): { dir: string; repo: string }[] {
  const found: { dir: string; repo: string }[] = [];

  function walk(rel: string, depth: number): void {
    if (depth > MAX_PATH_DEPTH) return;
    const abs = rel === "" ? modelsRoot : join(modelsRoot, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 竞态删除：跳过该子树，不让整次扫描失败
    }

    const marker = entries.find((e) => e.isFile() && e.name === REPO_MARKER_FILENAME);
    if (marker !== undefined && rel !== "") {
      try {
        const raw = JSON.parse(readFileSync(join(abs, REPO_MARKER_FILENAME), "utf8")) as {
          repo?: unknown;
        };
        if (typeof raw.repo === "string") found.push({ dir: rel, repo: raw.repo });
      } catch {
        // 标记文件损坏：当作普通目录，继续往下扫
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      walk(rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1);
    }
  }

  walk("", 1);
  return found;
}

export interface DeleteProfileArgs {
  id: number;
  /** true 递归删掉整个目录；false（默认）只删 DB 行与标记文件 */
  deleteFiles: boolean;
}

export interface DeleteProfileResult {
  /** 删除的档案目录 */
  targetDir: string;
  filesDeleted: boolean;
}

/**
 * 删除档案。三层语义与「删除模型」对齐：默认只解除管理关系（目录降级为普通
 * 文件夹），显式要求才动文件；有配置引用目录内文件时拒绝删文件并列出配置名。
 */
export function deleteProfile(
  deps: RepoProfileDeps,
  args: DeleteProfileArgs,
): DeleteProfileResult {
  const { db, modelsRoot } = deps;
  const profile = getProfile(db, args.id);
  if (profile === null) {
    throw new RepoProfileError("NOT_FOUND", `NOT_FOUND: 档案不存在: ${args.id}`);
  }

  const unfinished = db
    .prepare(
      `SELECT COUNT(*) AS c FROM download_tasks
       WHERE repo_id = ? AND status IN ('pending', 'downloading', 'paused')`,
    )
    .get(args.id) as { c: number };
  if (unfinished.c > 0) {
    throw new RepoProfileError("LOCKED", `LOCKED: 该档案有 ${unfinished.c} 个未完成的下载任务`);
  }

  if (args.deleteFiles) {
    const referrers = new Set<string>();
    for (const [rel, refs] of buildRefMap(db, modelsRoot)) {
      if (rel === profile.targetDir || rel.startsWith(`${profile.targetDir}/`)) {
        for (const ref of refs) referrers.add(ref.modelName);
      }
    }
    if (referrers.size > 0) {
      throw new RepoProfileError(
        "LOCKED",
        `LOCKED: 目录内文件仍被配置引用: ${[...referrers].join(", ")}`,
      );
    }
  }

  // 先删 DB 行，再动文件：DB 写如果失败（外键、约束等），不能让文件已经先
  // 没了却留下一个删不掉的档案行——那是彻底的死路。反过来，DB 行删掉之后
  // 文件删失败，坏结果只是「目录变成没人管的普通文件夹」，用户能在文件页
  // 自己清理，可自救。
  db.prepare("DELETE FROM model_repos WHERE id = ?").run(args.id);

  if (args.deleteFiles) {
    rmSync(join(modelsRoot, profile.targetDir), { recursive: true, force: true });
  } else {
    const marker = join(modelsRoot, profile.targetDir, REPO_MARKER_FILENAME);
    if (existsSync(marker)) unlinkSync(marker);
  }

  return { targetDir: profile.targetDir, filesDeleted: args.deleteFiles };
}

export interface MoveProfileArgs {
  id: number;
  toBaseDir: string;
}

export interface MoveProfileResult {
  from: string;
  to: string;
  renamed: number;
}

/**
 * 换存放位置 = 整个 `<base>/<owner>/<repo>/` 目录搬到新 base。
 *
 * 直接复用 renameFolder —— 它上一批已支持多级路径，物理 mv + gguf_file /
 * mmproj_file 引用重写 + file_meta 迁移全是现成的，这里只补一句档案表更新。
 * 标记文件跟着目录走，内容不用改（它只记 repo，不记位置）。
 */
export function moveProfile(deps: RepoProfileDeps, args: MoveProfileArgs): MoveProfileResult {
  const { db, modelsRoot, runningModel } = deps;
  const profile = getProfile(db, args.id);
  if (profile === null) {
    throw new RepoProfileError("NOT_FOUND", `NOT_FOUND: 档案不存在: ${args.id}`);
  }
  if (!isValidBaseDir(args.toBaseDir)) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 存放目录非法: ${args.toBaseDir}`);
  }
  if (args.toBaseDir === profile.baseDir) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 目标目录与当前相同`);
  }

  const to = repoTargetDir(args.toBaseDir, profile.repo);
  // 目标目录不得与另一份档案相同或互相嵌套（缺陷 2）——排除自己，否则移动
  // 前的旧目录会被误判为"与自己冲突"。注意这与 renameFolder 内部
  // existsSync 的"目标已存在于磁盘"判定不是同一件事：这里判的是"目标已被
  // 另一份档案登记"，磁盘上不存在但 DB 里已登记的情况也可能出现（比如目录
  // 被手工删掉过），两者都要挡。
  assertDirAvailable(db, to, profile.id);
  const result = renameFolder(
    { db, modelsRoot, runningModel },
    { from: profile.targetDir, to },
  );
  db.prepare("UPDATE model_repos SET base_dir = ? WHERE id = ?").run(args.toBaseDir, args.id);
  return { from: profile.targetDir, to, renamed: result.renamed };
}
