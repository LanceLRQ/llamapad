import type Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { rewriteRefPrefix } from "../lib/file-move-plan";
import { moveFiles, type RefUpdate } from "./fileMove";
import {
  assertFolderInsideRoot,
  buildRefMap,
  FileMoveGuardError,
  isExistingDir,
  type FileRefChange,
} from "./filesApi";
import { MAX_DIR_DEPTH, scanTree } from "./fsScanner";
import { createModelRepo } from "./repo/models";

/**
 * 文件夹（models 根目录树中的一个目录，可多级）管理服务层（阶段 1b B2 起；
 * 阶段 3a 起支持多级路径 + 新建目录，故独立成模块，不塞进已经很大的
 * filesApi.ts）。
 *
 * 与命名空间服务彻底切割（阶段 1b B1 拆分后的立场）：文件夹是磁盘目录，
 * 命名空间是模型配置的逻辑标签，二者多对多、互不隐含——重命名/新建文件
 * 夹绝不碰 models.namespace 字段，只重写 gguf_file / mmproj_file 里指向
 * 该目录的路径段（含 glob 形态）；反过来 namespaces.ts 的 renameNamespace
 * 也绝不再碰磁盘（见该文件顶部注释）。
 */

export type FolderErrorCode = "INVALID_NAME" | "NOT_FOUND" | "CONFLICT" | "LOCKED";

/** 业务错误：code 供 route 映射状态码，风格对齐 NamespaceError / FileMoveGuardError */
export class FolderError extends Error {
  readonly code: FolderErrorCode;

  constructor(code: FolderErrorCode, message: string) {
    super(message);
    this.name = "FolderError";
    this.code = code;
  }
}

/** FolderErrorCode → HTTP 状态码：INVALID_NAME/CONFLICT→400、NOT_FOUND→404、
 * LOCKED→423，与 filesApi.fileMoveGuardStatus 的口径保持一致 */
export function folderErrorStatus(code: FolderErrorCode): number {
  switch (code) {
    case "INVALID_NAME":
    case "CONFLICT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "LOCKED":
      return 423;
  }
}

/**
 * 目录路径安全校验（阶段 3a：由"仅一级目录"放开为多级路径），拒绝：
 * 空串/纯空白、绝对路径、".." 段、resolve 后逃逸 models 根（复用
 * filesApi.assertFolderInsideRoot 的四道检查——逃逸校验本就该只有一份
 * 实现，folders.ts 与 filesApi.ts 都在处理"models 根下的相对路径"这同一类
 * 输入，没有理由各写一套）、任一段以 "." 开头（隐藏目录，防止误改名/新建
 * 到 .git / .DS_Store 之类的系统级目录——scanTree 对隐藏目录也是同样一律
 * 跳过，这里不拦，改完的目录会在文件页里凭空"消失"）。
 *
 * assertFolderInsideRoot 本身不做 trim 空白校验（" " 是合法目录名字符，
 * resolve 后仍在 models 根内），这里在调用前单独补一道——保留这条历史
 * 行为（改造前的 assertValidFolderName 就有），防止用户把纯空格当目录名。
 */
function assertValidFolderName(modelsRoot: string, name: string, label: string): void {
  if (name.trim().length === 0) {
    throw new FolderError("INVALID_NAME", `INVALID_NAME: ${label} 不能为空`);
  }
  try {
    assertFolderInsideRoot(modelsRoot, name);
  } catch (error) {
    if (!(error instanceof FileMoveGuardError)) throw error;
    throw new FolderError("INVALID_NAME", `INVALID_NAME: ${label} ${error.message}`);
  }
  if (name.split("/").some((seg) => seg.startsWith("."))) {
    throw new FolderError(
      "INVALID_NAME",
      `INVALID_NAME: ${label} 不允许包含以 . 开头的目录段（隐藏目录）: ${name}`,
    );
  }
}

export interface RenameFolderDeps {
  db: Database.Database;
  /** 面板视角 models 根：面板自己的全部文件系统操作（存在性判断、
   * buildRefMap、实际的 mkdirSync/renameSync 落盘）一律走这一个根——
   * 宿主视角根在容器内本来就不可见，只用于交给 Docker 做 bind 挂载，
   * 绝不能用来拼面板自己要读写的本地路径（真机曾因此把新目录写进一个
   * 容器内谁都看不见的位置，见任务 H）。 */
  modelsRoot: string;
  /** 当前运行模型名（无则 null） */
  runningModel: string | null;
}

export interface RenameFolderArgs {
  from: string;
  to: string;
}

export interface RenameFolderResult {
  /** 改名目录下的文件数（展示用，"移动了 N 个文件"） */
  renamed: number;
  refUpdates: FileRefChange[];
}

/**
 * 重命名 models 根下的一个目录（阶段 3a 起可以是多级路径）：整目录一次
 * renameSync + 单事务批量重写全部引用者的 gguf_file / mmproj_file。
 *
 * 守卫顺序（按需求钉死，不与 planFileMove 的文件级顺序强行对齐——目录级
 * 改名没有"文件缺失也要精确匹配"的顾虑，判空目标比判锁便宜，先判）：
 * 路径安全 → NOT_FOUND（from 不存在）→ CONFLICT（to 已存在）→
 * LOCKED（目录下有文件被运行中模型引用）。
 *
 * from/to 阶段 3a 起均可为多级路径（如 "main/70b" → "shared/70b"）；新增一条
 * 校验放在路径合法性之后、存在性判断之前：不允许把目录改名到自身或自己的
 * 子目录里（"a" → "a/b"）——renameSync 对这种"目标是源的后代"的调用行为
 * 未定义（部分平台报 EINVAL，部分会产生目录自己嵌套自己的诡异结果），必须
 * 在调用前就地拦截，不能指望 renameSync 报错后兜底。
 */
export function renameFolder(deps: RenameFolderDeps, args: RenameFolderArgs): RenameFolderResult {
  const { db, modelsRoot, runningModel } = deps;
  const { from, to } = args;

  assertValidFolderName(modelsRoot, from, "from");
  assertValidFolderName(modelsRoot, to, "to");
  if (to === from || to.startsWith(`${from}/`)) {
    throw new FolderError(
      "INVALID_NAME",
      `INVALID_NAME: to 不允许是 from 自身或其子目录: ${to}`,
    );
  }

  if (!isExistingDir(join(modelsRoot, from))) {
    throw new FolderError("NOT_FOUND", `NOT_FOUND: 文件夹不存在: ${from}`);
  }
  if (existsSync(join(modelsRoot, to))) {
    throw new FolderError("CONFLICT", `CONFLICT: 目标已存在: ${to}`);
  }

  // refMap 必须在物理 mv 之前算好：mv 之后 from 目录不存在，resolveModelFiles
  // 对仍写着旧目录段的 glob/精确路径只会展开出零命中，查不到任何引用者
  const refMap = buildRefMap(db, modelsRoot);
  const prefix = `${from}/`;

  if (runningModel !== null) {
    for (const [rel, refs] of refMap) {
      if (rel.startsWith(prefix) && refs.some((r) => r.modelName === runningModel)) {
        throw new FolderError(
          "LOCKED",
          `LOCKED: 文件夹 ${from} 下有文件被运行中模型 ${runningModel} 引用，已锁定（停止模型后才能重命名）`,
        );
      }
    }
  }

  // 引用重写清单：以 modelName::field 去重——同一字段可能因 glob 展开命中
  // 该目录下多个物理文件，只需重写一次；glob 形态保留。改名与 namespaces.ts
  // moveModelFiles 的移动不是同一件事：整目录 renameSync 会完整保留子目录
  // 结构（exp/sub/b.gguf 改名后落在 lab/sub/b.gguf），引用值也必须保留这段
  // 中间目录，因此用 rewriteRefPrefix（只换前缀、其余路径原样保留），不能
  // 像移动场景那样用只留 basename 的 rewriteRefFolder——这正是缺陷 2 的
  // 来源：曾经这里错误复用了 rewriteRefFolder，把 exp/sub/b.gguf 改写成
  // lab/b.gguf，与 renameSync 之后的真实磁盘位置 lab/sub/b.gguf 对不上。
  const repo = createModelRepo(db);
  const seen = new Set<string>();
  const refUpdates: RefUpdate[] = [];
  const refChanges: FileRefChange[] = [];
  for (const [rel, refs] of refMap) {
    if (!rel.startsWith(prefix)) continue;
    for (const ref of refs) {
      const key = `${ref.modelName}::${ref.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const oldValue = repo.getModel(ref.modelName)?.[ref.field];
      if (oldValue === undefined) continue; // 理论不可达：引用来自当前库存模型
      const nextValue = rewriteRefPrefix(oldValue, from, to);
      refUpdates.push({ modelName: ref.modelName, field: ref.field, nextValue });
      refChanges.push({ modelName: ref.modelName, field: ref.field, from: oldValue, to: nextValue });
    }
  }

  // 改名目录下的文件数（展示用）：阶段 3a 起 from 内部可能嵌套子目录，
  // 直接 readdirSync 只数得到直接子项（把子目录也数成 1 个"文件"，嵌套
  // 内容完全漏计）——改用 scanTree 递归展开求和，与"文件夹现在可以嵌套"
  // 这件事本身保持口径一致（scanTree 同样跳过隐藏文件、同样受深度上限约束）。
  const renamed = scanTree(join(modelsRoot, from)).reduce((n, g) => n + g.files.length, 0);

  // 整目录一次 renameSync 而不是逐文件 move：目录改名在文件系统层面天然是
  // 一次原子操作（同一文件系统内 rename() 一个目录不需要逐个搬子项），逐个
  // mv 目录里的文件不但多付 N 次 syscall，中途失败还会留下"半个目录已经
  // 搬到新目录、半个还在旧目录"的更难处理的中间态。
  //
  // to 若为多级路径，父目录可能尚不存在（如 to="lab/sub" 但 "lab" 还没建过）：
  // renameSync 不会像 mkdirSync 那样自动建好中间目录，此处补一次 recursive
  // mkdir——否则"改名支持多级路径"这句话只在父目录凑巧已存在时才成立，
  // 大多数真实场景（挪进一个全新的二级目录）反而会 ENOENT 崩掉。
  mkdirSync(dirname(join(modelsRoot, to)), { recursive: true });
  renameSync(join(modelsRoot, from), join(modelsRoot, to));

  // 物理移动已经在上面做完，这里用空 from/to 只借 moveFiles 的单事务批量
  // 重写 + file_meta 联动迁移——与 namespaces.moveModelFiles 的零命中分支
  // 同款用法（该函数头注释里也提了这个既有用法）
  moveFiles({ db }, { from: [], to: [], refUpdates });

  return { renamed, refUpdates: refChanges };
}

export interface CreateFolderDeps {
  /** 面板视角 models 根：存在性判断与 mkdirSync 落盘都走这一个根（与
   * RenameFolderDeps.modelsRoot 同款理由——宿主视角根只交给 Docker bind
   * 挂载，不能拿来拼面板自己的文件系统路径） */
  modelsRoot: string;
}

export interface CreateFolderArgs {
  /** 相对 models 根的目录路径，可多级（一次建好，不要求父目录预先存在） */
  path: string;
}

export interface CreateFolderResult {
  path: string;
}

/**
 * 新建 models 根下的一个目录（C5 服务层部分）：路径安全走与
 * assertValidFolderName 同款校验（含隐藏目录段拒绝），额外加一条这里独有的
 * 深度上限——新建是从无到有凭空造路径，没有"已有磁盘结构约束着不会太深"
 * 这层天然保护，用户手滑输入 a/b/c/.../z 这种路径会一次性建出一整棵没人
 * 会用的深层空目录，MAX_DIR_DEPTH 与 repoProfiles.createProfile /
 * importService.importRepos 共用同一常量（比 scanTree/resolveModelFiles 的
 * MAX_PATH_DEPTH 少 1，见 fsScanner.ts 顶部该常量的注释），超过后不新建、
 * 报 INVALID_NAME（而不是静默截断——截断会建出一个用户没有要求过的目录，
 * 比直接拒绝更容易让人困惑）。
 *
 * 已存在（无论是目录还是同名文件）→ CONFLICT，口径与 renameFolder 的 to
 * 冲突判定一致（existsSync 不区分文件/目录，见该函数同款注释）。
 */
export function createFolder(deps: CreateFolderDeps, args: CreateFolderArgs): CreateFolderResult {
  const { modelsRoot } = deps;
  const { path: rel } = args;

  assertValidFolderName(modelsRoot, rel, "path");
  if (rel.split("/").length > MAX_DIR_DEPTH) {
    throw new FolderError(
      "INVALID_NAME",
      `INVALID_NAME: path 目录层级超过上限（${MAX_DIR_DEPTH} 层）: ${rel}`,
    );
  }
  if (existsSync(join(modelsRoot, rel))) {
    throw new FolderError("CONFLICT", `CONFLICT: 目标已存在: ${rel}`);
  }

  mkdirSync(join(modelsRoot, rel), { recursive: true });
  return { path: rel };
}
