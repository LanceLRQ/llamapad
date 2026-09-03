import { readdirSync, statSync, type Dirent } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";

/**
 * models 目录树扫描与模型文件解析（M1 Task 3，panel 视角 fs 操作；阶段 3a
 * 起支持任意层级目录，见下方「多级目录」小节）
 *
 * glob 方言（不引第三方依赖）：
 * - `*` → [^/]*（段内任意、不跨 /）；`?` → [^/]（单字符）；其余字符字面量转义
 * - 不支持 ** / [] / {}（逐段匹配够用，跨段通配没有真实需求）
 *
 * 多级目录（阶段 3a）：pattern 按 "/" 拆成 N 段，前 N-1 段逐层匹配目录名
 * （每段独立编译成正则，不跨 "/"），最后一段匹配文件名——两层结构只是这个
 * 模型里 N=2 的特例，不再是"ns 段 + 文件段"的专门两段式拆法（那正是深层
 * pattern 失效的根因：main/sub/*.gguf 曾经被当成 ns="main"、文件段
 * "sub/*.gguf" 再整体编译成一个正则，而文件名正则不跨 "/"，永远零命中）。
 *
 * MAX_PATH_DEPTH：路径总段数（含文件名段）上限，scanTree 的目录递归、
 * resolveModelFiles 的 glob 匹配两处共用同一个数字——防软链环导致递归无限
 * 深，也防用户误建深层结构后每次扫描/匹配都要遍历一整棵大树。超限一律
 * "零命中/不再展开"，不抛错：这是容量保护而不是用户输入校验，抛错会让一个
 * 已经存在但纯属"建太深"的目录在扫描页上报错，而不是安静地在列表里少一层。
 * 新建/落盘类的深度前置校验（folders.createFolder、repoProfiles.createProfile、
 * importService.importRepos）改用下方 MAX_DIR_DEPTH，理由见其注释。
 *
 * 通用约定：
 * - 隐藏文件/目录（. 开头，如 .DS_Store）在 glob 匹配与目录扫描中一律跳过
 *   （精确路径不跳过——显式配置的路径按字面解析）
 * - rel 一律为相对 modelsRoot 的路径（各段之间用 / 连接）
 * - 安全：relPath 任一路径段为 ".." 时抛 Error，防逃逸 models 根
 *   （glob 形式的逃逸同样在匹配前拦截）
 */

/** 路径总段数（含文件名段，若适用）上限，见上方模块注释 */
export const MAX_PATH_DEPTH = 8;

/** 目录段数上限（比 MAX_PATH_DEPTH 少 1）：新建/落盘目录本身不含文件名段，
 * 但目录里迟早会有文件，那个文件的路径就是"目录段数 + 1"——目录段数若
 * 顶到 MAX_PATH_DEPTH，其内文件必然超过 MAX_PATH_DEPTH，会被 walkTree
 * 整个跳过（建得出来但全站看不见：文件页/模型页/档案页/文件夹下拉都不再
 * 展示这层）。folders.createFolder、repoProfiles.createProfile、
 * importService.importRepos 的深度前置校验用这个常量，不是 MAX_PATH_DEPTH——
 * 如需调整两个常量必须一起改（src/lib/repo-path.ts 里还有一份本地重新
 * 声明，同样要跟着改，见该文件内注释）。 */
export const MAX_DIR_DEPTH = MAX_PATH_DEPTH - 1;

/** models 树中的一个文件：rel 相对根、size 字节、mtime 毫秒、ino inode 号
 *  （硬链接去重用：同 ino 的多个路径在磁盘上是同一份数据，占盘只能算一次） */
export interface ModelFile {
  rel: string;
  size: number;
  mtime: number;
  ino: number;
}

/** resolveModelFiles 结果：命中文件列表 + 是否缺失（精确不存在 / glob 零命中） */
export interface ResolvedModelFiles {
  files: ModelFile[];
  missing: boolean;
}

/** scanTree 结果：models 树中一个目录（folder 为相对根的完整路径，空串代表
 * 根本身）与其直接文件（不含子目录内容——子目录是各自独立的条目） */
export interface FolderFiles {
  folder: string;
  files: ModelFile[];
}

/** glob 段 → 锚定正则：* → [^/]*、? → [^/]，其余字符按字面量转义 */
function globSegmentToRegExp(segment: string): RegExp {
  let source = "";
  for (const ch of segment) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) source += `\\${ch}`;
    else source += ch;
  }
  return new RegExp(`^${source}$`);
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** 判断 errno 是否"不存在"（ENOENT）；其他错误原样抛出 */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** stat 单个文件取 size/mtime；非普通文件（目录等）返回 null（跟随符号链接）。
 * 抛出原始 fs 错误——resolveModelFiles 的精确路径分支需要区分 ENOENT 与其它
 * 错误（后者原样抛出，是该分支明确要的行为），因此这里保留会抛错的版本，
 * 递归遍历改用下面的 statFileSafe。 */
function statFile(abs: string): { size: number; mtime: number; ino: number } | null {
  const st = statSync(abs);
  return st.isFile() ? { size: st.size, mtime: st.mtimeMs, ino: st.ino } : null;
}

/** 递归扫描专用：stat 失败一律当作"这个条目读不到"返回 null，不冒泡异常。
 * readdirSync 的 Dirent 用 lstat 语义，符号链接的 isDirectory() 恒为
 * false，会落进这里再由 statSync 跟随链接——断链 symlink（常见于挂载盘被
 * 卸载）由此抛 ENOENT；EACCES（权限不足）、ELOOP（符号链接环）同理，都不
 * 该让整棵递归中断。不只吞 ENOENT 是因为扫描是展示用途：单个条目读不到
 * stat，直接不计入清单，远好过让文件页/模型页/档案页/文件夹下拉整页 500。 */
function statFileSafe(abs: string): { size: number; mtime: number; ino: number } | null {
  try {
    return statFile(abs);
  } catch {
    return null;
  }
}

/** 按相对路径排序（code-unit 字典序，跨平台确定） */
function byRel(a: ModelFile, b: ModelFile): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/**
 * 逐段匹配 + 递归下降：dirPatterns 为剩余待匹配的目录段正则（已消费的段
 * 通过 dirRelSoFar 累积成前缀），dirPatterns 耗尽时对 dirAbs 下的直接文件
 * 跑 fileRe。递归深度天然受 dirPatterns 初始长度约束（每层消费一段），
 * 不会因软链环无限递归——调用方在入口处另按 MAX_PATH_DEPTH 直接拒绝过深
 * 的 pattern，这里不用重复判深度。
 */
function matchGlobDir(
  dirAbs: string,
  dirRelSoFar: string,
  dirPatterns: readonly RegExp[],
  fileRe: RegExp,
  out: ModelFile[],
): void {
  if (dirPatterns.length === 0) {
    let names: string[];
    try {
      names = readdirSync(dirAbs);
    } catch (error) {
      if (isENOENT(error)) return;
      throw error;
    }
    for (const name of names) {
      if (isHidden(name) || !fileRe.test(name)) continue;
      const meta = statFileSafe(join(dirAbs, name));
      if (meta === null) continue;
      out.push({ rel: dirRelSoFar === "" ? name : `${dirRelSoFar}/${name}`, ...meta });
    }
    return;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return;
    throw error;
  }

  const [pattern, ...rest] = dirPatterns;
  for (const entry of entries) {
    if (!entry.isDirectory() || isHidden(entry.name) || !pattern.test(entry.name)) continue;
    const nextRel = dirRelSoFar === "" ? entry.name : `${dirRelSoFar}/${entry.name}`;
    matchGlobDir(join(dirAbs, entry.name), nextRel, rest, fileRe, out);
  }
}

/**
 * 按配置中的 gguf 路径解析实际文件列表。
 * - 精确路径（无 * / ?）：存在 → 单元素；不存在 → missing（不受 MAX_PATH_DEPTH
 *   限制——已配置的精确路径必须始终可解析，不能因为深就假装不存在）
 * - glob 路径：逐段匹配后按文件名（rel）排序返回；零命中 → missing；
 *   段数（含文件名段）超过 MAX_PATH_DEPTH 直接零命中，不触碰文件系统
 * - relPath 任一段为 ".." → 抛 Error
 */
export function resolveModelFiles(modelsRoot: string, relPath: string): ResolvedModelFiles {
  const segments = relPath.split("/");
  if (segments.includes("..")) {
    throw new Error(`gguf 路径不允许包含 ..（防逃逸 models 根）: ${relPath}`);
  }

  // ---------- 精确路径 ----------
  if (!relPath.includes("*") && !relPath.includes("?")) {
    const abs = join(modelsRoot, ...segments);
    let meta: { size: number; mtime: number; ino: number } | null;
    try {
      meta = statFile(abs);
    } catch (error) {
      if (isENOENT(error)) return { files: [], missing: true };
      throw error;
    }
    if (meta === null) return { files: [], missing: true };
    return { files: [{ rel: relPath, ...meta }], missing: false };
  }

  // ---------- glob：逐段匹配（前 N-1 段是目录、末段是文件名） ----------
  if (segments.length > MAX_PATH_DEPTH) return { files: [], missing: true };

  const dirPatterns = segments.slice(0, -1).map(globSegmentToRegExp);
  const fileRe = globSegmentToRegExp(segments[segments.length - 1]);

  const files: ModelFile[] = [];
  matchGlobDir(modelsRoot, "", dirPatterns, fileRe, files);

  files.sort(byRel);
  return { files, missing: files.length === 0 };
}

/**
 * 递归收集 dirAbs（相对根路径为 dirRel）下每一层目录的直接文件，写入 out。
 * models 根本身（isRoot）只有在有直接文件时才成一条目——它不是"被父目录
 * readdir 发现的子目录"，而是递归起点，空手时凭空多一条 folder: "" 的记录
 * 只会打破"清单里出现的目录都是真有内容/真被发现"这条既有观感；非根目录
 * 只要存在就无条件成一条目（哪怕暂时没有直接文件，只是个空壳或只有子
 * 目录），这与改造前"一级目录清单来自 readdirSync 结果"的语义一脉相承。
 *
 * depth 为 dirRel 的目录段数（根为 0）；本目录直接文件的总段数是
 * depth + 1，超过 MAX_PATH_DEPTH 时整个目录（含其子树）不再展开——
 * 不是"文件不算数"，是压根不读这层目录，理由见模块顶部注释。
 */
function walkTree(dirAbs: string, dirRel: string, depth: number, isRoot: boolean, out: FolderFiles[]): void {
  if (depth + 1 > MAX_PATH_DEPTH) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return;
    throw error;
  }

  const files: ModelFile[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
      continue;
    }
    const meta = statFileSafe(join(dirAbs, entry.name));
    if (meta !== null) {
      files.push({ rel: dirRel === "" ? entry.name : `${dirRel}/${entry.name}`, ...meta });
    }
  }
  files.sort(byRel);

  if (!isRoot || files.length > 0) out.push({ folder: dirRel, files });

  for (const name of subdirs.sort()) {
    const nextRel = dirRel === "" ? name : `${dirRel}/${name}`;
    walkTree(join(dirAbs, name), nextRel, depth + 1, false, out);
  }
}

/**
 * 扫描 models 目录树：每一层目录各自一条目（folder 为相对根的完整路径，
 * 空串代表根本身），只含该目录的直接文件——子目录不再"跳过"，而是各自
 * 独立的条目（阶段 3a 由两层拓展为任意层级）。
 * - 跳过隐藏目录与隐藏文件（. 开头）
 * - modelsRoot 不存在 → 空数组（不抛）；其他 fs 错误原样抛出
 * - 结果按 folder 排序（空串排最前），files 按文件名排序
 * - 受 MAX_PATH_DEPTH 深度上限约束，见 walkTree 注释
 */
export function scanTree(modelsRoot: string): FolderFiles[] {
  const out: FolderFiles[] = [];
  walkTree(modelsRoot, "", 0, true, out);
  out.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
  return out;
}

// ---------- 内存索引：同一批路径反复 glob 匹配时避免重复扫盘 ----------

/** rel → 文件元信息的只读索引，由 buildModelFileIndex 一次扫描产出 */
export type ModelFileIndex = ReadonlyMap<string, ModelFile>;

/**
 * 把 scanTree(modelsRoot) 的结果拍平成 rel → ModelFile 索引，供
 * resolveGlobFilesFromIndex 复用。用于"同一批模型的多个路径字段要反复对
 * 同一棵树做 glob 匹配"的场景（如 namespaces.listOverview：N 个模型、每个
 * 最多两个字段，若各自调 resolveModelFiles，glob 值每次都会触发一次
 * matchGlobDir 递归扫盘）——这里先扫一次盘建好索引，后续全部在内存里查。
 */
export function buildModelFileIndex(modelsRoot: string): ModelFileIndex {
  const index = new Map<string, ModelFile>();
  for (const { files } of scanTree(modelsRoot)) {
    for (const file of files) index.set(file.rel, file);
  }
  return index;
}

/**
 * resolveModelFiles 的 glob 分支的内存版本：不触达文件系统，而是在
 * buildModelFileIndex 建好的索引里逐条匹配——复用同一个 globSegmentToRegExp
 * 编译出的正则，不是另起一套匹配语义，因此与实时扫盘结果一致。
 *
 * 只处理 glob 值（含 * 或 ?）：精确路径本就是单次 statSync，直接调用
 * resolveModelFiles 更省事，不必先建索引；索引来自 scanTree，会跳过隐藏
 * 文件/目录，而精确路径不受这条限制（模块顶部注释里的既有约定：显式配置
 * 的精确路径按字面解析），传精确路径进来会因为索引不含隐藏文件而误判缺失，
 * 调用方须按上面的分工调用，不要用本函数处理精确路径。
 * 段数超过 MAX_PATH_DEPTH、relPath 含 ".." 段的处理与 resolveModelFiles 的
 * glob 分支一致（零命中 / 抛错）。
 */
export function resolveGlobFilesFromIndex(index: ModelFileIndex, relPath: string): ModelFile[] {
  const segments = relPath.split("/");
  if (segments.includes("..")) {
    throw new Error(`gguf 路径不允许包含 ..（防逃逸 models 根）: ${relPath}`);
  }
  if (segments.length > MAX_PATH_DEPTH) return [];

  const dirPatterns = segments.slice(0, -1).map(globSegmentToRegExp);
  const fileRe = globSegmentToRegExp(segments[segments.length - 1]);

  const files: ModelFile[] = [];
  for (const [rel, file] of index) {
    const relSegments = rel.split("/");
    if (relSegments.length !== segments.length) continue;
    if (
      dirPatterns.every((re, i) => re.test(relSegments[i])) &&
      fileRe.test(relSegments[relSegments.length - 1])
    ) {
      files.push(file);
    }
  }
  files.sort(byRel);
  return files;
}

// ---------- 磁盘占用汇总（M1 Task 9，概览页磁盘卡 + GET /api/v1/disk 共用） ----------

/** 单个命名空间的占用 */
export interface NamespaceUsage {
  namespace: string;
  /** 该一级目录下全部文件字节数之和（含其下任意深度子目录） */
  bytes: number;
}

/** models 树占用视图 */
export interface DiskUsage {
  /** 所在文件系统总容量（bsize × blocks）；statfs 失败（含根不存在）时为 null */
  totalBytes: number | null;
  /** models 树全部文件字节数之和（含根下散落文件，各一级目录求和） */
  usedBytes: number;
  /** 各一级目录占用（按 namespace 排序，不含根下散落文件——见下方取舍说明） */
  perNamespace: NamespaceUsage[];
}

/**
 * 汇总 models 树磁盘占用：scanTree(panelModelsRoot) 现在按任意深度返回全部
 * 目录层级，这里把每条目录条目的字节数按"所属一级目录"（rel 的首段）
 * 归并——子目录（如 main/70b）的字节数累加到 main 上，否则概览页磁盘卡会
 * 突然冒出一堆子目录条目，破坏这张卡"按一级目录分组"的既有阅读习惯。
 *
 * 根下散落文件（folder === ""）取舍：不给它造一个空名条目挤进
 * perNamespace 列表（"" 不是任何人会认作命名空间的东西），字节数直接并入
 * usedBytes 总计——它们确实占磁盘，只是不属于任何一级目录，统计口径上
 * 归入"总量"而不是"分组明细"。
 *
 * NamespaceUsage/DiskUsage.perNamespace 本次改动刻意不动（概览页磁盘卡的
 * 既有数据结构，不在术语拆分范围内）——scanTree 的返回字段改叫 folder 后，
 * 这里只是取用时把它塞回 namespace 这个字段名，两个术语在磁盘占用这个
 * 场景里恰好重合（占用统计天然是按磁盘目录分的），不是本函数偷懒没改全。
 */
export async function getDiskUsage(modelsRoot: string): Promise<DiskUsage> {
  const byTop = new Map<string, number>();
  let usedBytes = 0;

  for (const { folder, files } of scanTree(modelsRoot)) {
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    usedBytes += bytes;
    if (folder === "") continue; // 根下散落文件只计入总计，理由见上方注释
    const top = folder.split("/")[0]!;
    byTop.set(top, (byTop.get(top) ?? 0) + bytes);
  }

  const perNamespace: NamespaceUsage[] = [...byTop.entries()]
    .map(([namespace, bytes]) => ({ namespace, bytes }))
    .sort((a, b) => (a.namespace < b.namespace ? -1 : 1));

  let totalBytes: number | null = null;
  try {
    const st = await statfs(modelsRoot);
    totalBytes = st.bsize * st.blocks;
  } catch {
    totalBytes = null;
  }
  return { totalBytes, usedBytes, perNamespace };
}
