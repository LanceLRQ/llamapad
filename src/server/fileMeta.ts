import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { detectQuant, shardGroup, shardInfo } from "../core/files";
import { computeFullHash, computeSampleHash } from "../core/fingerprint";
import { moveFiles, type RefUpdate } from "./fileMove";
import { buildRefMap } from "./filesApi";
import { resolveModelFiles, scanTree } from "./fsScanner";
import { createModelRepo } from "./repo/models";

/**
 * 文件元信息（file_meta，设计 §3，`docs/_internal/features/
 * 2026-08-28-文件管理与镜像管理-design.md`）
 *
 * 一行 = 一个逻辑条目，与 gguf_file / mmproj_file 里存的值字面一致：单文件是
 * 相对路径，分片组是 glob。指纹取自组内首片（probe_path 记录取自哪个物理文件）。
 *
 * 登记时机：不单开"新建"接口——listFileMeta 对全部模型配置里出现过的
 * gguf_file / mmproj_file 字段原始值（逻辑条目，glob 保持 glob 形态，不展开成
 * 物理文件）逐个做一次幂等的 upsertFileMeta，探测不到物理文件时静默跳过。
 * 这样文件元信息天然跟随模型配置的引用集合演进，不需要额外的注册钩子。
 * 注意与 buildRefMap 的区别：buildRefMap 对 glob 会展开成物理文件逐个登记
 * （删除/移动场景要的是"物理文件 → 引用者"），而这里要的是"一行 = 一个逻辑
 * 条目"（设计 §3.1），两者不可混用。
 *
 * 指纹缓存：命中条件 = probe_path + size + mtime 三者都不变，与 gguf_meta 的
 * 缓存策略同源——内容没变就不重新读 8 MiB 采样。三者任一变化视为内容变了，
 * 旧的 full_sha256 随之作废（重新算，不沿用）。
 */

/** file_meta 表行（数据库原始形态，snake_case 对齐 schema） */
interface FileMetaRow {
  id: number;
  path: string;
  is_group: number;
  probe_path: string;
  size: number | null;
  mtime: number | null;
  sample_sha256: string | null;
  full_sha256: string | null;
  quant_label: string | null;
  mark: string | null;
  created_at: number;
  updated_at: number;
}

/** 对外的文件元信息条目：camelCase + 派生字段（isOrphan / detectedQuant） */
export interface FileMetaEntry {
  id: number;
  path: string;
  isGroup: boolean;
  probePath: string;
  size: number | null;
  mtime: number | null;
  sampleSha256: string | null;
  fullSha256: string | null;
  /** 用户手填的量化标签（PUT 写入的原始值） */
  quantLabel: string | null;
  /** 从文件名推断出的量化标签，仅供展示参考，不应预填进编辑框（设计 §3.5） */
  detectedQuant: string | null;
  mark: string | null;
  /** meta 有、磁盘无（probe_path 已不是普通文件），设计 §3.6 */
  isOrphan: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 可编辑字段（quantLabel / mark 都是"存在即写入"语义：传 null 显式清空） */
export interface FileMetaPatch {
  quantLabel?: string | null;
  mark?: string | null;
}

/** 自动寻找命中的候选（不落库，交由调用方决定是否 relink） */
export interface LocateCandidate {
  /** 应写入 gguf_file/mmproj_file 与 file_meta.path 的值：分片组是重建的 glob，单文件是字面路径 */
  nextValue: string;
  /** 实际用于取指纹的物理文件相对路径（分片组=首片） */
  probePath: string;
  size: number;
  mtime: number;
  fullSha256: string;
}

export type FileMetaErrorCode = "NOT_FOUND" | "INVALID_VALUE";

export class FileMetaError extends Error {
  readonly code: FileMetaErrorCode;
  constructor(code: FileMetaErrorCode, message: string) {
    super(message);
    this.name = "FileMetaError";
    this.code = code;
  }
}

/** 路径是否含本面板 glob 方言的通配符（与 filesApi.hasGlob 同定义） */
function hasGlob(relPath: string): boolean {
  return relPath.includes("*") || relPath.includes("?");
}

/** probe_path 对应的物理文件当前是否还在（用普通文件判断，目录不算） */
function fileExists(modelsRoot: string, rel: string): boolean {
  try {
    return statSync(resolve(modelsRoot, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * 分片组的下一个配置值：组内首片 → 重建成与向导落库形态一致的 glob
 * （`<前缀>-*.gguf`，与 wizard.tsx 的落库约定字面一致）；非分片文件原样返回。
 */
function nextValueFor(rel: string): string {
  const segments = rel.split("/");
  const name = segments[segments.length - 1];
  const group = shardGroup(name);
  if (group === null || group.total <= 1) return rel;
  return [...segments.slice(0, -1), `${group.prefix}-*.gguf`].join("/");
}

function toEntry(modelsRoot: string, row: FileMetaRow): FileMetaEntry {
  const name = row.path.split("/").pop() ?? row.path;
  return {
    id: row.id,
    path: row.path,
    isGroup: row.is_group === 1,
    probePath: row.probe_path,
    size: row.size,
    mtime: row.mtime,
    sampleSha256: row.sample_sha256,
    fullSha256: row.full_sha256,
    quantLabel: row.quant_label,
    detectedQuant: detectQuant(name),
    mark: row.mark,
    isOrphan: !fileExists(modelsRoot, row.probe_path),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(db: Database.Database, path: string): FileMetaRow | undefined {
  return db.prepare("SELECT * FROM file_meta WHERE path = ?").get(path) as FileMetaRow | undefined;
}

/**
 * 登记或刷新一条文件元信息（设计 §3.3：登记时只算采样哈希，full_sha256 允许为
 * NULL）。path 探测不到物理文件（missing）时返回 null，静默跳过——调用方
 * （listFileMeta）遍历的是当前有效引用集合，缺失文件另有「文件缺失」提示路径，
 * 不在这里重复处理。
 *
 * 缓存命中（probe_path/size/mtime 三者都与上次登记一致）时直接返回既有行，不
 * 重新读盘；否则视为内容变化，重算采样哈希并让旧 full_sha256 作废（若这个物理
 * 文件恰好是某个已完成下载任务的落盘目标，直接从 download_tasks.sha256 免费
 * 播种 full_sha256——HF 的 sha256 就是 LFS oid，URL 直链的是下载器边下边算出的
 * actualSha，见 downloader.ts + manager.ts 的回写）。
 */
export async function upsertFileMeta(
  db: Database.Database,
  modelsRoot: string,
  path: string,
): Promise<FileMetaEntry | null> {
  const resolved = resolveModelFiles(modelsRoot, path);
  if (resolved.missing) return null;

  const probe = resolved.files[0]; // 分片组按 rel 排序后取首片
  const existing = getRow(db, path);

  if (
    existing &&
    existing.probe_path === probe.rel &&
    existing.size === probe.size &&
    existing.mtime === probe.mtime
  ) {
    return toEntry(modelsRoot, existing);
  }

  const sampleSha256 = await computeSampleHash(resolve(modelsRoot, probe.rel));
  const seeded = db
    .prepare(
      `SELECT sha256 FROM download_tasks
       WHERE target_rel = ? AND status = 'completed' AND sha256 IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(probe.rel) as { sha256: string } | undefined;

  // 完整哈希优先级：播种值最高（下载任务命中，见上）；其次，若新采样哈希与
  // 该行旧值相同，内容极大概率没变——只是换了位置或 mtime 被刷新（移动/改名
  // 会走到这条分支：probe_path 变了触发缓存未命中，但字节没动），保留旧的
  // full_sha256，不因此作废；采样哈希也变了才是内容真的变了，旧值随之作废。
  const contentUnchanged = existing !== undefined && existing.sample_sha256 === sampleSha256;
  const fullSha256 = seeded?.sha256 ?? (contentUnchanged ? existing!.full_sha256 : null);

  const now = Date.now();
  db.prepare(
    `
    INSERT INTO file_meta(
      path, is_group, probe_path, size, mtime, sample_sha256, full_sha256,
      quant_label, mark, created_at, updated_at
    ) VALUES (
      @path, @is_group, @probe_path, @size, @mtime, @sample_sha256, @full_sha256,
      @quant_label, @mark, @created_at, @updated_at
    )
    ON CONFLICT(path) DO UPDATE SET
      is_group = excluded.is_group,
      probe_path = excluded.probe_path,
      size = excluded.size,
      mtime = excluded.mtime,
      sample_sha256 = excluded.sample_sha256,
      full_sha256 = excluded.full_sha256,
      updated_at = excluded.updated_at
    `,
  ).run({
    path,
    is_group: hasGlob(path) ? 1 : 0,
    probe_path: probe.rel,
    size: probe.size,
    mtime: probe.mtime,
    sample_sha256: sampleSha256,
    full_sha256: fullSha256,
    quant_label: existing?.quant_label ?? null,
    mark: existing?.mark ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });

  return toEntry(modelsRoot, getRow(db, path)!);
}

/**
 * 元信息列表（GET /api/v1/file-meta 数据源）：先对登记集合逐个 upsertFileMeta
 * 幂等登记/刷新，再整表查出，含孤儿标记（isOrphan，见 §3.6）。
 *
 * 登记集合 = 配置引用的逻辑条目 ∪ 游离文件（refs === 0）。
 *
 * 加游离文件是本批（本地权重迁移）的需要：L2 校验算出的 full_sha256 得有地方
 * 缓存，否则每次扫描都要把几十 GB 重读一遍；顺带让「未登记」视图的「有备注」
 * 标签成立。models 外的文件不登记——path 受 ggufPathSchema 约束必须是根内
 * 相对路径，而外部导入是一次性动作，导入完文件就在库内了，不值当为它改 schema。
 *
 * 逻辑条目 ≠ buildRefMap 展开的物理文件：分片组的字段值是一条 glob
 * （`main/m1-*.gguf`），这里原样登记成一行，不展开成组内每个分片各一行
 * （设计 §3.1）。游离文件没有配置字段可言，直接以物理相对路径登记（单文件形态）。
 */
export async function listFileMeta(
  db: Database.Database,
  modelsRoot: string,
): Promise<FileMetaEntry[]> {
  const configPaths = new Set<string>();
  for (const model of createModelRepo(db).listModels()) {
    for (const field of ["gguf_file", "mmproj_file"] as const) {
      const configured = model[field];
      if (configured !== undefined) configPaths.add(configured);
    }
  }

  const referenced = new Set(buildRefMap(db, modelsRoot).keys());
  const unclaimed = scanTree(modelsRoot)
    .flatMap((g) => g.files)
    .filter((f) => f.rel.endsWith(".gguf") && !referenced.has(f.rel))
    .map((f) => f.rel);

  const paths = new Set([...configPaths, ...unclaimed]);
  for (const path of paths) {
    await upsertFileMeta(db, modelsRoot, path);
  }
  const rows = db.prepare("SELECT * FROM file_meta ORDER BY path").all() as FileMetaRow[];
  return rows.map((row) => toEntry(modelsRoot, row));
}

/** 编辑 quant_label / mark（PUT /api/v1/file-meta）。字段不存在于 patch 视为不动，null 视为显式清空 */
export function setFileMetaFields(
  db: Database.Database,
  modelsRoot: string,
  path: string,
  patch: FileMetaPatch,
): FileMetaEntry {
  const existing = getRow(db, path);
  if (!existing) throw new FileMetaError("NOT_FOUND", `文件元信息不存在: ${path}`);

  db.prepare("UPDATE file_meta SET quant_label = @quant_label, mark = @mark, updated_at = @updated_at WHERE path = @path").run({
    path,
    quant_label: "quantLabel" in patch ? patch.quantLabel : existing.quant_label,
    mark: "mark" in patch ? patch.mark : existing.mark,
    updated_at: Date.now(),
  });

  return toEntry(modelsRoot, getRow(db, path)!);
}

/**
 * 自动寻找候选（设计 §3.4，不落库）：候选池 = models 树中未被任何配置引用的文件
 * （buildRefMap 补集），分片组只留首片代表。逐候选先比采样哈希，命中后比完整
 * 哈希确认；条目 full_sha256 为 NULL 时视为首次建立基线，不参与比较、直接采信
 * 采样命中（回填交给调用方在确认 relink 时落库，locate 本身不写库）。
 */
export async function locateCandidates(
  db: Database.Database,
  modelsRoot: string,
  path: string,
): Promise<LocateCandidate[]> {
  const entry = getRow(db, path);
  if (!entry) throw new FileMetaError("NOT_FOUND", `文件元信息不存在: ${path}`);
  if (entry.sample_sha256 === null) {
    throw new FileMetaError("INVALID_VALUE", `条目尚无采样哈希，无法自动寻找: ${path}`);
  }

  const referenced = new Set(buildRefMap(db, modelsRoot).keys());
  const results: LocateCandidate[] = [];

  for (const { files } of scanTree(modelsRoot)) {
    for (const file of files) {
      if (referenced.has(file.rel)) continue;

      const name = file.rel.split("/").pop()!;
      const info = shardInfo(name);
      if (info !== null && info.total > 1 && info.index !== 1) continue; // 分片组只留首片代表

      const abs = resolve(modelsRoot, file.rel);
      const sample = await computeSampleHash(abs);
      if (sample !== entry.sample_sha256) continue;

      const fullSha256 = await computeFullHash(abs);
      if (entry.full_sha256 !== null && entry.full_sha256 !== fullSha256) continue; // 采样碰撞，丢弃

      results.push({
        nextValue: nextValueFor(file.rel),
        probePath: file.rel,
        size: file.size,
        mtime: file.mtime,
        fullSha256,
      });
    }
  }
  return results;
}

/**
 * 确认重链（设计 §3.4 第 5 步）：事务内更新引用旧 path 的全部模型配置 +
 * file_meta.path/probe_path。复用 fileMove.moveFiles 原语——candidateNextValue
 * 对应的物理文件已经在目标位置，from/to 传同一路径即为 no-op rename（POSIX
 * 同路径 rename 是原子无操作），借此拿到它「批量重写引用」的事务能力，不再
 * 另写一套。moveFiles 内部用 db.transaction()，本函数外层再包一层——
 * better-sqlite3 的嵌套事务走 SAVEPOINT，file_meta 那次 UPDATE 若失败，
 * moveFiles 已提交的引用改写也会一并回滚。
 *
 * file_meta.path 的落点：moveFiles 自身已经会把 refUpdates 里重写的
 * gguf_file/mmproj_file 值同步搬到 file_meta.path（跨模块联动，见其内部
 * 注释），refs 非空时这里进来时行已经在 candidateNextValue 上；refs 为空
 * （比如引用它的模型配置已被删除，只剩 meta 行）时 moveFiles 不会碰
 * file_meta，行还留在旧 path。probe_path/is_group 这两个字段 moveFiles 不
 * 知道也不需要知道，仍由本函数负责，用「当前实际在哪个 path 上」兜底两种
 * 情况，一次 UPDATE 补齐。
 */
export function relinkFile(
  db: Database.Database,
  modelsRoot: string,
  path: string,
  candidateNextValue: string,
): FileMetaEntry {
  const entry = getRow(db, path);
  if (!entry) throw new FileMetaError("NOT_FOUND", `文件元信息不存在: ${path}`);

  const resolved = resolveModelFiles(modelsRoot, candidateNextValue);
  if (resolved.missing) {
    throw new FileMetaError("INVALID_VALUE", `候选路径不存在: ${candidateNextValue}`);
  }
  const probe = resolved.files[0];
  const probeAbs = resolve(modelsRoot, probe.rel);

  // 按模型配置的字段值直接匹配，不能用 buildRefMap：后者的 key 是 glob 展开后的
  // 物理文件路径，而 file_meta.path 是逻辑条目（分片组为 glob 字面串），glob 在
  // 那张表里永远查不到 → refUpdates 为空 → 重链只搬了 file_meta、模型配置仍指着
  // 旧位置，等于没修好。listFileMeta 也是以字段值为登记粒度，两处保持同一口径。
  const refUpdates: RefUpdate[] = [];
  for (const model of createModelRepo(db).listModels()) {
    if (model.gguf_file === path) {
      refUpdates.push({ modelName: model.name, field: "gguf_file", nextValue: candidateNextValue });
    }
    if (model.mmproj_file === path) {
      refUpdates.push({
        modelName: model.name,
        field: "mmproj_file",
        nextValue: candidateNextValue,
      });
    }
  }

  db.transaction(() => {
    moveFiles({ db }, { from: [probeAbs], to: [probeAbs], refUpdates });

    const stillAtOldPath = getRow(db, path) !== undefined;
    if (stillAtOldPath) {
      // moveFiles 没碰过 file_meta（refs 为空），这里独立改名，同样要防
      // candidateNextValue 撞上一条孤儿行（语义与 moveFiles 内部一致）
      db.prepare("DELETE FROM file_meta WHERE path = ?").run(candidateNextValue);
    }
    db.prepare(
      "UPDATE file_meta SET path = @newPath, probe_path = @probe_path, is_group = @is_group, updated_at = @updated_at WHERE path = @currentPath",
    ).run({
      newPath: candidateNextValue,
      probe_path: probe.rel,
      is_group: hasGlob(candidateNextValue) ? 1 : 0,
      updated_at: Date.now(),
      currentPath: stillAtOldPath ? path : candidateNextValue,
    });
  })();

  return toEntry(modelsRoot, getRow(db, candidateNextValue)!);
}

/** 手动计算完整哈希（POST /api/v1/file-meta/checksum，路由层负责不阻塞地跑它） */
export async function computeAndStoreFullHash(
  db: Database.Database,
  modelsRoot: string,
  path: string,
): Promise<string> {
  const entry = getRow(db, path);
  if (!entry) throw new FileMetaError("NOT_FOUND", `文件元信息不存在: ${path}`);
  if (!fileExists(modelsRoot, entry.probe_path)) {
    throw new FileMetaError("NOT_FOUND", `物理文件已不存在，无法计算完整哈希: ${entry.probe_path}`);
  }

  const fullSha256 = await computeFullHash(resolve(modelsRoot, entry.probe_path));
  db.prepare("UPDATE file_meta SET full_sha256 = ?, updated_at = ? WHERE path = ?").run(
    fullSha256,
    Date.now(),
    path,
  );
  return fullSha256;
}

/** 清理孤儿记录（meta 有、磁盘无，设计 §3.6）：返回实际删除的行数 */
export function clearOrphans(db: Database.Database, modelsRoot: string): number {
  const rows = db.prepare("SELECT path, probe_path FROM file_meta").all() as {
    path: string;
    probe_path: string;
  }[];
  const orphanPaths = rows.filter((r) => !fileExists(modelsRoot, r.probe_path)).map((r) => r.path);
  if (orphanPaths.length === 0) return 0;

  const placeholders = orphanPaths.map(() => "?").join(",");
  const info = db.prepare(`DELETE FROM file_meta WHERE path IN (${placeholders})`).run(...orphanPaths);
  return Number(info.changes);
}
