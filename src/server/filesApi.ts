import type Database from "better-sqlite3";
import { readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { shardGroup } from "../core/files";
import {
  planRename,
  rewriteRefBasename,
  rewriteRefFolder,
  shardGroupMembers,
} from "../lib/file-move-plan";
import { repoDirOf, repoTargetDir } from "../lib/repo-path";
import type { RefUpdate } from "./fileMove";
import { resolveModelFiles, scanTree, type ModelFile } from "./fsScanner";
import { createModelRepo } from "./repo/models";

/**
 * 文件引用扫描与三层删除语义（M1 Task 10，设计 §5.4）
 *
 * 删除分三层：删配置（DB 行，T8）→ 删文件（本模块）→ 删命名空间（T12）。
 * 删文件的语义：
 * - 引用扫描：同文件多配置引用是一等场景。引用分两种——精确引用
 *   （配置路径 === 文件 relPath，与磁盘无关，文件缺失也算引用）与
 *   glob 引用（配置写 `main/qwen-*.gguf`，磁盘是具体分片）：后者按
 *   resolveModelFiles 在 modelsRoot 上展开后比对，展开零命中则不构成引用
 * - 删除守卫（按优先级）：
 *   1. INVALID_PATH —— relPath 含 .. / 绝对路径 / resolve 后逃逸 models 根
 *   2. LOCKED —— 引用中含当前运行模型：无论 force 一律拒绝（运行中文件锁定）
 *   3. REFERENCED —— 有引用且未 force：拒绝并附引用清单（route 映射 409）
 *   4. NOT_FOUND —— 目标文件不存在（含 glob 零命中）
 * - 真删：relPath 含通配符时按 glob 展开后全删，否则删单个文件
 *
 * siblingShards 只做"同组还有哪些分片"的提示（UI 确认框用），不自动删组。
 * route 层编排顺序：getFileRefs → 运行模型名 → deleteFile（见 /api/v1/files）。
 */

/** 引用来源字段：模型配置里可能指向目标文件的两列 */
export type FileRefField = "gguf_file" | "mmproj_file";

/** 一条文件引用：哪个模型、经哪个字段引用 */
export interface FileRef {
  modelName: string;
  field: FileRefField;
}

/** deleteFile / getFileRefs 的业务错误码（route 据此映射 HTTP 状态） */
export type FileApiErrorCode = "INVALID_PATH" | "NOT_FOUND" | "REFERENCED" | "LOCKED";

/** 业务错误：code 供 route 映射状态码，refs 附引用清单（REFERENCED / LOCKED 时） */
export class FileApiError extends Error {
  readonly code: FileApiErrorCode;
  readonly refs: FileRef[] | undefined;

  constructor(code: FileApiErrorCode, message: string, refs?: FileRef[]) {
    super(message);
    this.name = "FileApiError";
    this.code = code;
    this.refs = refs;
  }
}

/** 路径是否含本面板 glob 方言的通配符（与 fsScanner 的判定一致：* 与 ?） */
function hasGlob(relPath: string): boolean {
  return relPath.includes("*") || relPath.includes("?");
}

/**
 * 校验 relPath 合法且 resolve 后仍在 modelsRoot 内，否则抛 INVALID_PATH。
 * 三道防线：非空、非绝对路径且无 ".." 段（含空段拒绝，防 `a//b` 绕过）、
 * resolve 后前缀兜底比对（与 fsScanner 的防逃逸约定一致）。
 */
function assertInsideRoot(modelsRoot: string, relPath: string): void {
  if (relPath.length === 0) {
    throw new FileApiError("INVALID_PATH", "INVALID_PATH: 路径为空");
  }
  if (isAbsolute(relPath)) {
    throw new FileApiError("INVALID_PATH", `INVALID_PATH: 不允许绝对路径: ${relPath}`);
  }
  const segments = relPath.split("/");
  if (segments.some((s) => s === ".." || s === "")) {
    throw new FileApiError("INVALID_PATH", `INVALID_PATH: 路径不允许包含 .. 或空段: ${relPath}`);
  }
  const root = resolve(modelsRoot);
  const resolved = resolve(modelsRoot, relPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new FileApiError("INVALID_PATH", `INVALID_PATH: 路径逃逸 models 根: ${relPath}`);
  }
}

/**
 * 一次遍历模型表构造 relPath → 引用清单 的索引。
 * - 精确配置：字符串相等即引用（文件在磁盘上缺失也算——配置仍指向它）
 * - glob 配置：resolveModelFiles(modelsRoot, 配置) 展开成具体文件后逐个登记；
 *   展开零命中（文件还没下回来）不构成对任何现存文件的引用
 *
 * 导出供 namespaces.ts（moveModel 的共享引用同步，设计 §2.6）与后续文件页
 * 移动/改名复用，不重复实现一份索引逻辑。
 */
export function buildRefMap(db: Database.Database, modelsRoot: string): Map<string, FileRef[]> {
  const map = new Map<string, FileRef[]>();
  function add(rel: string, modelName: string, field: FileRefField): void {
    const list = map.get(rel) ?? [];
    list.push({ modelName, field });
    map.set(rel, list);
  }

  for (const model of createModelRepo(db).listModels()) {
    for (const field of ["gguf_file", "mmproj_file"] as const) {
      const configured = model[field];
      if (configured === undefined) continue;
      if (hasGlob(configured)) {
        for (const f of resolveModelFiles(modelsRoot, configured).files) {
          add(f.rel, model.name, field);
        }
      } else {
        add(configured, model.name, field);
      }
    }
  }
  return map;
}

/**
 * 查询某个文件的引用清单：`[{ modelName, field }]`，无引用为空数组。
 * relPath 非法 / 逃逸 models 根 → INVALID_PATH（route 映射 400）。
 */
export function getFileRefs(
  db: Database.Database,
  modelsRoot: string,
  relPath: string,
): FileRef[] {
  assertInsideRoot(modelsRoot, relPath);
  return buildRefMap(db, modelsRoot).get(relPath) ?? [];
}

/** deleteFile 入参：route 编排时先取好引用与运行模型名再传入 */
export interface DeleteFileOptions {
  /** 该文件的引用清单（getFileRefs 的结果） */
  refs: FileRef[];
  /** 当前运行模型名（runtime.getRuntimeStatus().running?.model ?? null） */
  runningModel: string | null;
  /** 强制删除（越过 REFERENCED 确认；不能越过 LOCKED） */
  force?: boolean;
}

/** deleteFile 结果 */
export interface DeleteFileResult {
  /** 实际删除的相对路径（glob 展开后可能多个） */
  deleted: string[];
}

/**
 * 删除 models 树下的一个文件（或一个 glob 展开后的文件组）。
 * 守卫优先级：INVALID_PATH → LOCKED（运行中，force 也不放行）→
 * REFERENCED（未 force）→ NOT_FOUND；全部通过后逐个 unlink。
 * 目标不是普通文件（如目录）时按 INVALID_PATH 拒绝。
 */
export async function deleteFile(
  modelsRoot: string,
  relPath: string,
  options: DeleteFileOptions,
): Promise<DeleteFileResult> {
  assertInsideRoot(modelsRoot, relPath);

  if (
    options.runningModel !== null &&
    options.refs.some((r) => r.modelName === options.runningModel)
  ) {
    throw new FileApiError(
      "LOCKED",
      `LOCKED: 文件被运行中模型 ${options.runningModel} 引用，已锁定（停止模型后才能删除）`,
      options.refs,
    );
  }

  if (options.refs.length > 0 && !options.force) {
    const names = [...new Set(options.refs.map((r) => r.modelName))].join("、");
    throw new FileApiError(
      "REFERENCED",
      `REFERENCED: 文件被引用（${names}），确认后可强制删除`,
      options.refs,
    );
  }

  const targets = hasGlob(relPath)
    ? resolveModelFiles(modelsRoot, relPath).files.map((f) => f.rel)
    : [relPath];
  if (targets.length === 0) {
    throw new FileApiError("NOT_FOUND", `NOT_FOUND: 文件不存在: ${relPath}`);
  }

  const deleted: string[] = [];
  for (const rel of targets) {
    assertInsideRoot(modelsRoot, rel); // glob 展开结果兜底再校验
    const abs = resolve(modelsRoot, rel);

    let isFile: boolean;
    try {
      isFile = statSync(abs).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileApiError("NOT_FOUND", `NOT_FOUND: 文件不存在: ${rel}`);
      }
      throw error;
    }
    if (!isFile) {
      throw new FileApiError("INVALID_PATH", `INVALID_PATH: 不是普通文件，拒绝删除: ${rel}`);
    }

    try {
      await unlink(abs);
      deleted.push(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileApiError("NOT_FOUND", `NOT_FOUND: 文件不存在: ${rel}`);
      }
      throw error;
    }
  }
  return { deleted };
}

/**
 * 同组其余分片（提示用，不自动删组）：目标按 shardGroup 解析出前缀 + total，
 * 同目录下前缀与 total 都相同的其他文件即同组分片（排除自身），按名称排序。
 * 非分片命名 / total=1 / 目录不存在 → 空数组；relPath 非法 → INVALID_PATH。
 */
export function siblingShards(modelsRoot: string, relPath: string): string[] {
  assertInsideRoot(modelsRoot, relPath);

  const segments = relPath.split("/");
  const name = segments[segments.length - 1];
  const group = shardGroup(name);
  if (group === null || group.total <= 1) return [];

  const dir = join(modelsRoot, ...segments.slice(0, -1));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // 目录不存在等 → 视为无同组分片
  }

  const siblings: string[] = [];
  for (const entry of entries) {
    if (entry === name) continue;
    const g = shardGroup(entry);
    if (g !== null && g.prefix === group.prefix && g.total === group.total) {
      siblings.push([...segments.slice(0, -1), entry].join("/"));
    }
  }
  return siblings.sort();
}

// ---------- 批量删除（POST /api/v1/files/bulk-delete，U21） ----------

/** 批量删除单项跳过原因：与 route 的 skip 展示文案一一对应 */
export type BulkDeleteSkipReason = "locked" | "referenced" | "notFound";

export interface BulkDeleteResult {
  /** 实际删除的相对路径（顺序与入参一致） */
  deleted: string[];
  skipped: Array<{ path: string; reason: BulkDeleteSkipReason }>;
}

export interface BulkDeleteOptions {
  /** 当前运行模型名（同 DeleteFileOptions.runningModel） */
  runningModel: string | null;
  /** 强制删除 REFERENCED 项；LOCKED 项不受此影响（风险簿第 8 条） */
  force?: boolean;
}

/**
 * 批量删除编排：逐个走既有 getFileRefs + deleteFile 语义分类。
 * LOCKED（运行中模型引用）与 REFERENCED（未 force）/NOT_FOUND 归入 skipped，
 * 不中断后续项；INVALID_PATH 视为异常输入（正常来源只应是页面勾选的真实
 * relPath），整批立即中断并抛出——已处理成功的删除是 unlink，不可回滚，
 * 由调用方（route）决定如何呈现给用户（400，不写入成功事件）。
 */
export async function bulkDeleteFiles(
  db: Database.Database,
  modelsRoot: string,
  paths: string[],
  options: BulkDeleteOptions,
): Promise<BulkDeleteResult> {
  const deleted: string[] = [];
  const skipped: BulkDeleteResult["skipped"] = [];

  for (const relPath of paths) {
    const refs = getFileRefs(db, modelsRoot, relPath); // INVALID_PATH 在此抛出，中断整批

    try {
      const result = await deleteFile(modelsRoot, relPath, {
        refs,
        runningModel: options.runningModel,
        force: options.force,
      });
      deleted.push(...result.deleted);
    } catch (error) {
      if (error instanceof FileApiError) {
        if (error.code === "LOCKED") skipped.push({ path: relPath, reason: "locked" });
        else if (error.code === "REFERENCED") skipped.push({ path: relPath, reason: "referenced" });
        else if (error.code === "NOT_FOUND") skipped.push({ path: relPath, reason: "notFound" });
        else throw error; // INVALID_PATH：deleteFile 内部再校验一次，同样中断整批
        continue;
      }
      throw error;
    }
  }

  return { deleted, skipped };
}

// ---------- 文件树视图（GET /api/v1/files/tree 共用） ----------

/** 树中一个文件：ModelFile + 引用计数 */
export interface TreeFile extends ModelFile {
  /** 引用该文件的配置数（精确 + glob 展开） */
  refs: number;
}

/** 树中一个文件夹：目录名 + 文件列表（按文件名排序，来自 scanTree） */
export interface FolderTree {
  folder: string;
  files: TreeFile[];
}

/**
 * 文件树 + 每文件引用计数：scanTree(modelsRoot) 逐文件挂 refs
 * （buildRefMap 只构造一次索引，树大时不逐文件重扫）。
 */
export function getFilesTree(db: Database.Database, modelsRoot: string): FolderTree[] {
  const refMap = buildRefMap(db, modelsRoot);
  return scanTree(modelsRoot).map(({ folder, files }) => ({
    folder,
    files: files.map((f) => ({ ...f, refs: refMap.get(f.rel)?.length ?? 0 })),
  }));
}

// ---------- 文件移动 / 改名（T2，设计 §2.3/§2.4） ----------

/**
 * 移动/改名的守卫错误码：与 FileApiError 分开维护——错误码集合不同
 * （无 REFERENCED：决策 9 移动/改名总是同步全部引用，不设"仅挪文件"的软阻塞
 * 旁路；新增 CONFLICT：目标位置已有同名文件）。
 * 优先级（与 deleteFile 对齐）：INVALID_PATH → LOCKED → NOT_FOUND → CONFLICT。
 */
export type FileMoveGuardCode = "INVALID_PATH" | "LOCKED" | "NOT_FOUND" | "CONFLICT";

/** planFileMove / planFileRename 抛出的业务错误：code 供 route 映射状态码 */
export class FileMoveGuardError extends Error {
  readonly code: FileMoveGuardCode;

  constructor(code: FileMoveGuardCode, message: string) {
    super(message);
    this.name = "FileMoveGuardError";
    this.code = code;
  }
}

/** FileMoveGuardCode → HTTP 状态码（move/rename 两个 route 共用，风格对齐 namespaceErrorStatus） */
export function fileMoveGuardStatus(code: FileMoveGuardCode): number {
  switch (code) {
    case "INVALID_PATH":
      return 400;
    case "LOCKED":
      return 423;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
  }
}

/** 一条引用变更展示：供 route 组装响应体（moveFiles 只需要 nextValue，展示还需要旧值） */
export interface FileRefChange {
  modelName: string;
  field: FileRefField;
  from: string;
  to: string;
}

/**
 * planFileMove / planFileRename 的返回：只含 modelsRoot 视角的相对路径与
 * 引用重写计划，不含任何绝对路径——route 已知 hostRoot，自行拼出交给
 * fileMove.moveFiles 的绝对路径（与 namespaces.moveModel 同款分工：本层只管
 * "挪哪些相对路径、引用改成什么值"，物理落盘的根由调用方决定）。
 */
export interface FileMovePreview {
  /** 待物理移动/改名的文件相对路径（modelsRoot 视角），与 toRels 下标一一对应 */
  fromRels: string[];
  toRels: string[];
  /** 喂给 fileMove.moveFiles 的引用重写计划 */
  refUpdates: RefUpdate[];
  /** 响应展示用（modelName/field + 旧值/新值） */
  refChanges: FileRefChange[];
}

/** relPath 拆成目录路径（可多级）+ 文件名（阶段 3a：由"第一个 / 取一级目录"
 * 改为"最后一个 / 取完整目录路径"，两层结构是这个模型下 folder 恰好只有
 * 一段的特例）。无 "/" → 目录路径为空串（根下文件，合法值，不再抛错）。
 *
 * 不在这里做路径安全校验：调用方（planFileMove/planFileRename）已经在调用
 * 本函数之前跑过 assertInsideRoot(modelsRoot, relPath)，那道检查已经保证
 * relPath 非空、非绝对路径、无 ".." 段、无空段——到这里时最后一段必然非空，
 * 重复校验只会是死代码。 */
function splitFolderRel(relPath: string): { folder: string; basename: string } {
  const slash = relPath.lastIndexOf("/");
  return slash === -1
    ? { folder: "", basename: relPath }
    : { folder: relPath.slice(0, slash), basename: relPath.slice(slash + 1) };
}

/** splitFolderRel 的逆操作：folder + basename 拼回 relPath。folder 为空串
 * （根下文件）时不能简单地 `${folder}/${basename}`——那样会拼出带前导 "/"
 * 的 "/x.gguf"，与 resolveModelFiles/scanTree 期望的"根下文件 rel 就是裸
 * 文件名"不一致，getFileRefs 等下游查找会因为多出的前导 "/" 而查不到任何
 * 引用。阶段 3a 引入 folder === "" 这个合法值之前，folder 恒非空，这个坑
 * 从未暴露过。 */
function joinRel(folder: string, basename: string): string {
  return folder === "" ? basename : `${folder}/${basename}`;
}

/** 目录下全部文件名；目录不存在按空列表处理（不存在即无成员，不是异常） */
function listFolderEntries(modelsRoot: string, folder: string): string[] {
  try {
    return readdirSync(join(modelsRoot, folder));
  } catch {
    return [];
  }
}

/**
 * 校验目标目录字符串本身的路径安全性：与 assertInsideRoot 同一思路（拒绝
 * 空串 / 绝对路径 / .. 段 / resolve 后逃逸 models 根），但抛的是
 * FileMoveGuardError 而不是 FileApiError——planFileMove 的守卫错误体系统一
 * 挂在前者上（route 按 code 映射状态码用的是 fileMoveGuardStatus），跟
 * assertInsideRoot 共用同一个错误类反而会让 route 层多一种要处理的异常形状。
 *
 * 导出供 `server/download/manager.ts`（阶段 2 B3：入队下载校验 targetDir）
 * 复用——四道检查里除"整体空串"外的三道（绝对路径 / .. 段 / 逃逸）对下载
 * 场景同样成立，不该另写一套等价规则。整体空串那道对 manager 不适用：
 * 那里空串是"落 models 根"的合法值，调用方在传入本函数前会先短路放行，
 * 不是本函数职责范围的收窄。
 */
export function assertFolderInsideRoot(modelsRoot: string, folderRel: string): void {
  if (folderRel.length === 0) {
    throw new FileMoveGuardError("INVALID_PATH", "INVALID_PATH: 目标目录为空");
  }
  if (isAbsolute(folderRel)) {
    throw new FileMoveGuardError("INVALID_PATH", `INVALID_PATH: 目标目录不允许绝对路径: ${folderRel}`);
  }
  const segments = folderRel.split("/");
  if (segments.some((s) => s === ".." || s === "")) {
    throw new FileMoveGuardError("INVALID_PATH", `INVALID_PATH: 目标目录不允许包含 .. 或空段: ${folderRel}`);
  }
  const root = resolve(modelsRoot);
  const resolved = resolve(modelsRoot, folderRel);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new FileMoveGuardError("INVALID_PATH", `INVALID_PATH: 目标目录逃逸 models 根: ${folderRel}`);
  }
}

/** 目标是否为磁盘上已存在的目录（移动目标只能是既有目录，planFileMove 不
 * 自动新建——防手滑打错路径建出一堆空目录；新建目录是 folders.createFolder
 * 的显式独立操作，两者不合并：移动前"要不要顺手建目录"应该是用户主动做出
 * 的决定，不该被一次移动操作静默带过）。
 * 导出供 `server/namespaces.ts`（moveModelFiles 校验目标文件夹）与
 * `server/folders.ts`（renameFolder 校验 NOT_FOUND）复用——三处都是同一句
 * "目标是不是既有目录"的 stat 判断，值得共用一份而不是各自重新实现。 */
export function isExistingDir(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 聚合组内全部成员当前的引用（按 modelName::field 去重），回填每条引用当前
 * 的字段值——移动/改名总是同步全部引用（决策 9），需要旧值才能算出新值、
 * 也需要旧值供响应展示。
 */
function collectGroupRefs(
  db: Database.Database,
  modelsRoot: string,
  folder: string,
  groupBasenames: readonly string[],
): Array<{ modelName: string; field: FileRefField; currentValue: string }> {
  const repo = createModelRepo(db);
  const seen = new Set<string>();
  const result: Array<{ modelName: string; field: FileRefField; currentValue: string }> = [];
  for (const basename of groupBasenames) {
    for (const ref of getFileRefs(db, modelsRoot, joinRel(folder, basename))) {
      const key = `${ref.modelName}::${ref.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const currentValue = repo.getModel(ref.modelName)?.[ref.field];
      if (currentValue === undefined) continue; // 理论不可达：引用来自当前库存模型
      result.push({ modelName: ref.modelName, field: ref.field, currentValue });
    }
  }
  return result;
}

/** planFileMove 入参：from 为待移动文件相对路径，toFolder 为目标目录（相对 models 根） */
export interface PlanFileMoveArgs {
  from: string;
  toFolder: string;
}

/**
 * 移动计划（设计 §2.3 移动分支）：选中任一分片自动升级为整组移动；守卫顺序
 * INVALID_PATH → LOCKED → NOT_FOUND → CONFLICT。
 *
 * 目标目录校验（真机回归后改定，见项目变更记录）：曾经要求 toFolder 命中
 * models.namespace 配置表（`repo.listNamespaces()`）且满足命名空间字符集
 * `^[a-z0-9][a-z0-9-]*$`——但磁盘目录与命名空间表早已脱钩（真机 6 个磁盘
 * 目录里 namespaces 表只登记了 1 个，且有目录名带点号，两道校验会把 5/6 的
 * 磁盘目录当成非法移动目标），所以改成直接校验磁盘：目标必须是 models 根
 * 下已存在的目录，不接受临时新建（理由见 isExistingDir 注释）。
 */
export function planFileMove(
  db: Database.Database,
  modelsRoot: string,
  runningModel: string | null,
  args: PlanFileMoveArgs,
): FileMovePreview {
  // 逃逸防护前置：与 deleteFile 同款入口校验。此前靠 collectGroupRefs 内部的
  // getFileRefs 间接拦下 ../ 路径，但那是副作用而非设计意图——在它生效前
  // listFolderEntries 已经 readdir 过 models 根之外的目录，且一旦调整调用
  // 顺序防线就没了
  assertInsideRoot(modelsRoot, args.from);
  const { folder: fromFolder, basename } = splitFolderRel(args.from);

  assertFolderInsideRoot(modelsRoot, args.toFolder);
  if (args.toFolder === fromFolder) {
    throw new FileMoveGuardError(
      "INVALID_PATH",
      `INVALID_PATH: 目标目录与当前相同: ${args.toFolder}`,
    );
  }

  // 档案目录由档案独占管理（设计 §9.6）：里面的文件只能整组随档案换存放
  // 位置（走 repoProfiles.moveProfile → server/folders.ts renameFolder），
  // 单独移出会破坏 <base>/<owner>/<repo> 的对应关系，让「这个量化下过没有」
  // 的判定失真。UI 会禁用移动按钮，但规则必须在服务端立住——禁用只是提示，
  // API 本身可以被直接调用。
  //
  // 只挡 from 一侧：toFolder 命中档案目录时必须放行，那正是详情页「归位」
  // 按钮的路径（{ from: 散落文件, toFolder: 档案 targetDir }），把用户手动
  // 放错地方的同名文件搬回档案——加一道 toFolder 守卫会让这条已上线的功能
  // 直接 400。查询直接打原始表而不经 repoProfiles.listProfiles：后者反向
  // import 本文件的 buildRefMap，这里再 import 它会成环。
  const repoDirs = (
    db.prepare("SELECT base_dir, repo FROM model_repos").all() as {
      base_dir: string;
      repo: string;
    }[]
  ).map((r) => repoTargetDir(r.base_dir, r.repo));
  const fromRepo = repoDirOf(args.from, repoDirs);
  if (fromRepo !== null) {
    throw new FileMoveGuardError(
      "INVALID_PATH",
      `INVALID_PATH: 仓库目录内的文件不能单独移动（${fromRepo}），请到档案页整组换存放位置`,
    );
  }

  if (!isExistingDir(join(modelsRoot, args.toFolder))) {
    throw new FileMoveGuardError(
      "INVALID_PATH",
      `INVALID_PATH: 目标目录不存在: ${args.toFolder}（本阶段不支持自动新建，请先在磁盘上建好目录）`,
    );
  }

  const entries = listFolderEntries(modelsRoot, fromFolder);
  const exists = entries.includes(basename);
  const groupBasenames = exists ? shardGroupMembers(entries, basename) : [basename];

  // LOCKED 先于 NOT_FOUND：与 deleteFile 同款优先级——精确引用与磁盘无关，
  // 文件缺失也可能命中运行中模型的引用（此时同样锁定，不因"反正文件不在"放行）。
  const refs = collectGroupRefs(db, modelsRoot, fromFolder, groupBasenames);
  if (runningModel !== null && refs.some((r) => r.modelName === runningModel)) {
    throw new FileMoveGuardError(
      "LOCKED",
      `LOCKED: 文件被运行中模型 ${runningModel} 引用，已锁定（停止模型后才能移动）`,
    );
  }

  if (!exists) {
    throw new FileMoveGuardError("NOT_FOUND", `NOT_FOUND: 文件不存在: ${args.from}`);
  }

  const targetEntries = listFolderEntries(modelsRoot, args.toFolder);
  const conflict = groupBasenames.find((name) => targetEntries.includes(name));
  if (conflict !== undefined) {
    throw new FileMoveGuardError(
      "CONFLICT",
      `CONFLICT: 目标目录已存在同名文件: ${args.toFolder}/${conflict}`,
    );
  }

  const refChanges: FileRefChange[] = refs.map((r) => ({
    modelName: r.modelName,
    field: r.field,
    from: r.currentValue,
    to: rewriteRefFolder(r.currentValue, args.toFolder),
  }));

  return {
    // fromFolder 可能是根（""），toFolder 不会——assertFolderInsideRoot 已经
    // 拒绝空串，故这里 toFolder 侧不需要 joinRel 也不会拼出前导 "/"
    fromRels: groupBasenames.map((name) => joinRel(fromFolder, name)),
    toRels: groupBasenames.map((name) => `${args.toFolder}/${name}`),
    refUpdates: refChanges.map((c) => ({ modelName: c.modelName, field: c.field, nextValue: c.to })),
    refChanges,
  };
}

/** planFileRename 入参：from 为待改名文件相对路径，newName 单文件为完整新文件名、分片组为新前缀 */
export interface PlanFileRenameArgs {
  from: string;
  newName: string;
}

/** newName 字符集校验：不含 / 空白 冒号，与 core/schemas.ggufPathSchema 的约束同源 */
const NAME_COMPONENT_INVALID = /[/\s:]/;

/**
 * 改名计划（设计 §2.3 改名分支，决策 7）：单文件可改整个文件名（须保留
 * .gguf 后缀）；分片组只能改前缀，序号段系统保留。守卫顺序同 planFileMove。
 */
export function planFileRename(
  db: Database.Database,
  modelsRoot: string,
  runningModel: string | null,
  args: PlanFileRenameArgs,
): FileMovePreview {
  assertInsideRoot(modelsRoot, args.from); // 逃逸防护前置，理由同 planFileMove
  const { folder, basename } = splitFolderRel(args.from);

  if (args.newName === "" || NAME_COMPONENT_INVALID.test(args.newName)) {
    throw new FileMoveGuardError("INVALID_PATH", `INVALID_PATH: 新名字含非法字符: ${args.newName}`);
  }
  const isShardGroup = shardGroup(basename) !== null;
  if (!isShardGroup && !args.newName.endsWith(".gguf")) {
    throw new FileMoveGuardError("INVALID_PATH", "INVALID_PATH: 单文件改名必须保留 .gguf 后缀");
  }

  const entries = listFolderEntries(modelsRoot, folder);
  const exists = entries.includes(basename);
  const groupBasenames = exists ? shardGroupMembers(entries, basename) : [basename];

  const refs = collectGroupRefs(db, modelsRoot, folder, groupBasenames);
  if (runningModel !== null && refs.some((r) => r.modelName === runningModel)) {
    throw new FileMoveGuardError(
      "LOCKED",
      `LOCKED: 文件被运行中模型 ${runningModel} 引用，已锁定（停止模型后才能改名）`,
    );
  }

  if (!exists) {
    throw new FileMoveGuardError("NOT_FOUND", `NOT_FOUND: 文件不存在: ${args.from}`);
  }

  const plan = planRename(groupBasenames, basename, args.newName);
  const groupSet = new Set(groupBasenames);
  const conflict = plan.files.find(
    (f) => f.oldName !== f.newName && entries.includes(f.newName) && !groupSet.has(f.newName),
  );
  if (conflict !== undefined) {
    throw new FileMoveGuardError(
      "CONFLICT",
      `CONFLICT: 目标文件名已存在: ${joinRel(folder, conflict.newName)}`,
    );
  }

  const refChanges: FileRefChange[] = refs.map((r) => ({
    modelName: r.modelName,
    field: r.field,
    from: r.currentValue,
    to: rewriteRefBasename(r.currentValue, plan.refRewrite.oldPrefix, plan.refRewrite.newPrefix),
  }));

  return {
    fromRels: plan.files.map((f) => joinRel(folder, f.oldName)),
    toRels: plan.files.map((f) => joinRel(folder, f.newName)),
    refUpdates: refChanges.map((c) => ({ modelName: c.modelName, field: c.field, nextValue: c.to })),
    refChanges,
  };
}
