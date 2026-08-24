import type Database from "better-sqlite3";
import { readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { shardGroup } from "../core/files";
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
 */
function buildRefMap(db: Database.Database, modelsRoot: string): Map<string, FileRef[]> {
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

// ---------- 文件树视图（GET /api/v1/files/tree 共用） ----------

/** 树中一个文件：ModelFile + 引用计数 */
export interface TreeFile extends ModelFile {
  /** 引用该文件的配置数（精确 + glob 展开） */
  refs: number;
}

/** 树中一个命名空间：名称 + 文件列表（按文件名排序，来自 scanTree） */
export interface NamespaceTree {
  namespace: string;
  files: TreeFile[];
}

/**
 * 文件树 + 每文件引用计数：scanTree(modelsRoot) 逐文件挂 refs
 * （buildRefMap 只构造一次索引，树大时不逐文件重扫）。
 */
export function getFilesTree(db: Database.Database, modelsRoot: string): NamespaceTree[] {
  const refMap = buildRefMap(db, modelsRoot);
  return scanTree(modelsRoot).map(({ namespace, files }) => ({
    namespace,
    files: files.map((f) => ({ ...f, refs: refMap.get(f.rel)?.length ?? 0 })),
  }));
}
