import type Database from "better-sqlite3";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { rewriteRefFolder } from "../lib/file-move-plan";
import { moveFiles, type RefUpdate } from "./fileMove";
import { buildRefMap, isExistingDir, type FileRefChange } from "./filesApi";
import { createModelRepo } from "./repo/models";

/**
 * 文件夹（models 根一级目录）管理服务层（阶段 1b B2；阶段 3 还会往里加
 * 新建/删除，故独立成模块，不塞进已经很大的 filesApi.ts）。
 *
 * 与命名空间服务彻底切割（阶段 1b B1 拆分后的立场）：文件夹是磁盘一级
 * 目录，命名空间是模型配置的逻辑标签，二者多对多、互不隐含——重命名文件
 * 夹绝不碰 models.namespace 字段，只重写 gguf_file / mmproj_file 里指向
 * 该目录的路径段（含 glob 形态）；反过来 namespaces.ts 的 renameNamespace
 * 也绝不再碰磁盘（见该文件顶部注释）。
 *
 * 本阶段范围明确收窄在"一级目录改名"：from/to 都不含 "/"，更深层级的目录
 * 结构是后续阶段的事——校验与函数签名（RenameFolderArgs 是具名字段而非
 * 位置参数）留出扩展余地，真要支持多级路径时改校验规则即可，不用动调用方。
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
 * 一级目录名安全校验：拒绝含 "/"（本阶段目标只能是既有一级目录，多级是
 * 后续阶段的事）、".."、空串/纯空白、以 "." 开头（隐藏目录，防止误改到
 * .git / .DS_Store 之类的系统级目录）。
 *
 * 不复用 filesApi.assertFolderInsideRoot：那套是给"可能含多个目录段的相对
 * 路径"做逃逸检测（resolve 后与 modelsRoot 比前缀），这里的入参本来就禁止
 * 含 "/"，没有路径段可言、也没有逃逸检测的对象——一个不含 "/" 且不等于 ".."
 * 的名字，join(modelsRoot, name) 恒在 modelsRoot 内，照搬那套多做一次无意义
 * 的 resolve()。
 */
function assertValidFolderName(name: string, label: string): void {
  if (name.trim().length === 0) {
    throw new FolderError("INVALID_NAME", `INVALID_NAME: ${label} 不能为空`);
  }
  if (name.includes("/")) {
    throw new FolderError(
      "INVALID_NAME",
      `INVALID_NAME: ${label} 不允许包含 /（本阶段仅支持一级目录改名）: ${name}`,
    );
  }
  if (name === "..") {
    throw new FolderError("INVALID_NAME", `INVALID_NAME: ${label} 不允许为 ..: ${name}`);
  }
  if (name.startsWith(".")) {
    throw new FolderError(
      "INVALID_NAME",
      `INVALID_NAME: ${label} 不允许以 . 开头（隐藏目录）: ${name}`,
    );
  }
}

export interface RenameFolderDeps {
  db: Database.Database;
  /** 面板视角 models 根：存在性判断 / buildRefMap 用（与 filesApi.planFileMove
   * 的既有分工一致——判断"有没有"走面板自己看到的文件系统） */
  modelsRoot: string;
  /** 宿主视角 models 根：仅 renameSync 落盘用（对齐 files/move route 的
   * 用法，生产环境两根可能不同，见 namespaces.ts 顶部注释的同款约定） */
  hostRoot: string;
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
 * 重命名 models 根下的一个一级目录：整目录一次 renameSync + 单事务批量
 * 重写全部引用者的 gguf_file / mmproj_file。
 *
 * 守卫顺序（按需求钉死，不与 planFileMove 的文件级顺序强行对齐——目录级
 * 改名没有"文件缺失也要精确匹配"的顾虑，判空目标比判锁便宜，先判）：
 * 路径安全 → NOT_FOUND（from 不存在）→ CONFLICT（to 已存在）→
 * LOCKED（目录下有文件被运行中模型引用）。
 */
export function renameFolder(deps: RenameFolderDeps, args: RenameFolderArgs): RenameFolderResult {
  const { db, modelsRoot, hostRoot, runningModel } = deps;
  const { from, to } = args;

  assertValidFolderName(from, "from");
  assertValidFolderName(to, "to");

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
  // 该目录下多个物理文件，只需重写一次；glob 形态保留（参考 namespaces.ts
  // 的 retarget，这里复用同一职责的 rewriteRefFolder，逻辑上是同一件事）
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
      const nextValue = rewriteRefFolder(oldValue, to);
      refUpdates.push({ modelName: ref.modelName, field: ref.field, nextValue });
      refChanges.push({ modelName: ref.modelName, field: ref.field, from: oldValue, to: nextValue });
    }
  }

  // 整目录一次 renameSync 而不是逐文件 move：目录改名在文件系统层面天然是
  // 一次原子操作（同一文件系统内 rename() 一个目录不需要逐个搬子项），逐个
  // mv 目录里的文件不但多付 N 次 syscall，中途失败还会留下"半个目录已经
  // 搬到新目录、半个还在旧目录"的更难处理的中间态。
  const renamed = readdirSync(join(modelsRoot, from)).length;
  renameSync(join(hostRoot, from), join(hostRoot, to));

  // 物理移动已经在上面做完，这里用空 from/to 只借 moveFiles 的单事务批量
  // 重写 + file_meta 联动迁移——与 namespaces.moveModelFiles 的零命中分支
  // 同款用法（该函数头注释里也提了这个既有用法）
  moveFiles({ db }, { from: [], to: [], refUpdates });

  return { renamed, refUpdates: refChanges };
}
